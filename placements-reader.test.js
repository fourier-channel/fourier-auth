"use strict";

// The gate 3 placements reader (GATE3_CONTRACTS.md A2) with a fake Synapse
// and a fake booru: the push body, the cursor rules, paging bounds, the
// out-of-order tail re-read, the sweep, and the failure rules -- a failed push
// leaves the cursor, a 4xx stops it, a poisoned event is bisected into
// skipped. The SQL itself, and the reader end to end against a real Postgres,
// are in mediaauth-sql.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPlacementsReader, placementsBooruClient, parseReaderConfig, readerOffHealth, readerPool,
  PushRetryable, PushRejected, isDataError, parseMxc,
} = require("./placements-reader");

const HS = "41chan.net";
const U = "@up:41chan.net";
const mxc = (id) => `mxc://${HS}/${id}`;
const TOUCH = new Set(["m.room.message", "m.sticker", "m.room.avatar", "m.room.redaction"]);
const quiet = { log: () => {}, error: () => {} };
const dataError = () => Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" });
const outage = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

// A fake Synapse: events { so, id, type, room, url, redacts, poison }, and the
// image gate's answers as tables. Mirrors the contract of mediaauth-sql.js.
function synapse({ head, tail = 1, events = [], uploaders = {}, siteAssets = [], rooms = {} } = {}) {
  const w = {
    head: head ?? Math.max(0, ...events.map((e) => e.so)),
    tail,
    events,
    uploaders,
    siteAssets: new Set(siteAssets),
    rooms,
    fail: null,         // an error every query throws (Synapse down)
    touchFail: null,    // (from, to) -> error the touch page throws, or null
    answerFail: {},     // mxc -> error queryMediaRooms throws, or () -> error|null per call
    clock: 1_800_000_000_000,
    asked: [],
    snapshots: 0,
  };
  const touchRows = (from, to) => w.events.filter((e) => TOUCH.has(e.type) && e.so > from && e.so <= to).sort((a, b) => a.so - b.so);
  const q = {
    attempt: (f) => f(),
    queryStreamBounds: async () => { if (w.fail) throw w.fail; return { head: w.head, tail: w.tail, at: w.clock }; },
    queryTouchPage: async (from, to, limit) => {
      if (w.fail) throw w.fail;
      const tf = w.touchFail && w.touchFail(from, to);
      if (tf) throw tf;
      const rows = touchRows(from, to);
      if (rows.some((e) => e.poison)) throw dataError();
      return rows.slice(0, limit).map((e) => ({
        stream_ordering: e.so, event_id: e.id, type: e.type, room_id: e.room || "!r", sender: U,
        url: e.type === "m.room.redaction" ? null : e.url ?? null, redacts: e.redacts ?? null,
      }));
    },
    queryEventAt: async (so) => { const e = w.events.find((x) => x.so === so); return e ? { event_id: e.id, type: e.type } : null; },
    queryRedactionTargets: async (ids) => new Map(w.events.filter((e) => ids.includes(e.id)).map((e) => [e.id, e.url ?? null])),
    queryUploaders: async (ids) => new Map(ids.filter((id) => id in w.uploaders).map((id) => [id, w.uploaders[id]])),
    queryIsSiteAsset: async (m) => { w.asked.push(["site", m]); return w.siteAssets.has(m); },
    queryMediaRooms: async (m, up) => {
      w.asked.push(["rooms", m, up]);
      const af = typeof w.answerFail[m] === "function" ? w.answerFail[m]() : w.answerFail[m];
      if (af) throw af;
      return [...(w.rooms[m] || [])];
    },
    queryFirstReceivedAfter: async (so) => {
      const e = w.events.filter((x) => x.so > so).sort((a, b) => a.so - b.so)[0];
      return e ? e.received ?? w.clock : null;
    },
  };
  return { w, withSnapshot: async (fn) => { w.snapshots++; return fn(q); } };
}

// A fake booru that keeps the cursor the way the reader expects D to: each
// push moves that stream's cursor to the page's end. `answer` overrides the
// cursor it reports back (a booru that disagrees), `stale` the stale count.
function booru({ cursor = { live: 0, sweep: null, lap_started_at: null } } = {}) {
  const held = { ...cursor };
  const b = {
    pushes: [],
    cursorCalls: 0,
    held,
    next: [], // queued errors for push
    answer: null, // (placements, held) -> the cursor to report instead
    stale: 0,
    getCursor: async () => { b.cursorCalls++; if (b.cursorError) throw b.cursorError; return { ...held }; },
    push: async (body) => {
      const err = b.next.shift();
      if (err) throw err;
      b.pushes.push(body);
      const p = body.placements;
      held[p.stream] = p.to;
      return { cursor: b.answer ? b.answer(p, held) : { ...held }, applied: p.mxcs.length - b.stale, stale: b.stale };
    },
  };
  return b;
}

function reader(s, b, options = {}, extra = {}) {
  return createPlacementsReader({
    withSnapshot: s.withSnapshot, booru: b, homeserverName: HS, now: () => s.w.clock, log: quiet, ...extra,
    // The sweep is far in the future unless a test asks for it.
    options: { ...options },
  });
}
const img = (so, id, extra = {}) => ({ so, id: `$${so}`, type: "m.room.message", url: mxc(id), ...extra });
const livePushes = (b) => b.pushes.map((p) => p.placements).filter((p) => p.stream === "live");
const parked = { live: 0, sweep: 10_000, lap_started_at: 1_800_000_000_000 }; // sweep lap done; next lap in 24 h

test("config: unset and off are off; on needs both credentials; anything else is an error, never off-and-quiet", () => {
  assert.deepEqual(parseReaderConfig({}), { on: false, problem: null });
  assert.deepEqual(parseReaderConfig({ GATE3_READER: "off" }), { on: false, problem: null });
  const typo = parseReaderConfig({ GATE3_READER: "true" });
  assert.equal(typo.on, false);
  assert.match(typo.problem, /GATE3_READER is "true"; it is on or off/);
  assert.equal(readerOffHealth(typo).level, "red");
  assert.equal(readerOffHealth({ on: false, problem: null }).level, "green");
  const noCreds = parseReaderConfig({ GATE3_READER: "on" });
  assert.match(noCreds.problem, /BOORU_PLACEMENTS_LOGIN is unset; BOORU_PLACEMENTS_API_KEY is unset/);
  assert.match(noCreds.problem, /fourier_jail:create/);
  assert.match(parseReaderConfig({ GATE3_READER: "on", BOORU_PLACEMENTS_LOGIN: "gate", BOORU_PLACEMENTS_API_KEY: "k", GATE3_SWEEP_LAP_HOURS: "0" }).problem, /not a positive number/);
  const ok = parseReaderConfig({ GATE3_READER: "on", BOORU_PLACEMENTS_LOGIN: "gate", BOORU_PLACEMENTS_API_KEY: "k", GATE3_SWEEP_LAP_HOURS: "6" });
  assert.deepEqual(ok, { on: true, problem: null, login: "gate", apiKey: "k", lapHours: 6 });
});

test("push body: exactly the contract's shape, one answer per image, newest_ordering, rooms sorted", async () => {
  const s = synapse({
    head: 15610,
    events: [
      img(15550, "abc"),
      { so: 15560, id: "$t", type: "m.room.message", url: null },            // text: no image
      img(15570, "abc"),
      img(15580, "remote", { url: "mxc://matrix.org/remote" }),               // remote: skipped silently
      { so: 15590, id: "$av", type: "m.room.avatar", url: mxc("icon") },
    ],
    uploaders: { abc: U, icon: U },
    siteAssets: [mxc("icon")],
    rooms: { [mxc("abc")]: ["!r2:41chan.net", "!r1:41chan.net"], [mxc("icon")]: [] },
  });
  const b = booru({ cursor: { live: 15500, sweep: 10_000_000, lap_started_at: s.w.clock } });
  await reader(s, b).step();
  assert.equal(b.pushes.length, 1);
  assert.deepEqual(b.pushes[0], {
    placements: {
      stream: "live", from: 15500, to: 15610,
      snapshot: { head: 15610, at: s.w.clock },
      mxcs: [
        { mxc: mxc("abc"), uploader: U, site_asset: false, rooms: ["!r1:41chan.net", "!r2:41chan.net"], newest_ordering: 15570 },
        { mxc: mxc("icon"), uploader: U, site_asset: true, rooms: [], newest_ordering: 15590 },
      ],
      skipped: [],
    },
  });
});

test("the image gate's queries are asked with the uploader from local_media_repository; null for no record", async () => {
  const s = synapse({ head: 10, events: [img(5, "known"), img(6, "orphan")], uploaders: { known: U } });
  await reader(s, booru({ cursor: parked })).step();
  assert.deepEqual(s.w.asked.filter((a) => a[0] === "rooms"), [["rooms", mxc("known"), U], ["rooms", mxc("orphan"), null]]);
});

test("a redaction re-asks the image it took away, at the redaction's ordering", async () => {
  const s = synapse({ head: 30, events: [img(10, "gone", { id: "$post" }), { so: 20, id: "$red", type: "m.room.redaction", redacts: "$post" }] });
  const b = booru({ cursor: { ...parked, live: 15 } });
  await reader(s, b).step();
  assert.deepEqual(livePushes(b)[0].mxcs.map((m) => [m.mxc, m.newest_ordering]), [[mxc("gone"), 20]]);
});

test("start: with no live cursor at the booru the reader starts at Synapse's head -- history is the sweep's", async () => {
  const s = synapse({ head: 500, events: [img(100, "old")] });
  const b = booru({ cursor: { live: null, sweep: 10_000, lap_started_at: 1_800_000_000_000 } });
  const r = reader(s, b);
  await r.step();
  assert.equal(r.state().live, 500);
  assert.deepEqual(livePushes(b).flatMap((p) => p.mxcs), []);
  assert.equal(b.cursorCalls, 1, "the cursor is asked once, at start");
  await r.step();
  assert.equal(b.cursorCalls, 1);
});

test("FAILURE: a 5xx or network push leaves the cursor; backoff 5 s doubling to 5 min; the page is re-sent", async () => {
  const s = synapse({ head: 20, events: [img(10, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  b.next.push(new PushRetryable("answered 502"), new PushRetryable("answered 502"));
  assert.equal(await r.step(), 5000);
  assert.equal(r.state().live, 0, "the cursor did not move");
  assert.equal(r.health().level, "amber");
  assert.equal(await r.step(), 10000);
  assert.equal(r.state().live, 0);
  assert.equal(await r.step(), 2000, "recovered: back to the 2 s poll");
  assert.equal(r.state().live, 20);
  assert.deepEqual(livePushes(b).map((p) => [p.from, p.to, p.mxcs.length]), [[0, 20, 1]]);
  // The doubling stops at five minutes.
  const b2 = booru({ cursor: parked });
  const r2 = reader(s, b2);
  let last = 0;
  for (let i = 0; i < 12; i++) { b2.next.push(new PushRetryable("down")); last = await r2.step(); }
  assert.equal(last, 300000);
});

test("FAILURE: Synapse unreadable abandons the page -- nothing pushed, backoff, then it resumes", async () => {
  const s = synapse({ head: 20, events: [img(10, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  await r.step();
  s.w.events.push(img(25, "b"));
  s.w.head = 30;
  s.w.fail = outage();
  assert.equal(await r.step(), 5000);
  assert.equal(b.pushes.length, 1);
  s.w.fail = null;
  await r.step();
  assert.deepEqual(livePushes(b).at(-1).mxcs.map((m) => m.mxc), [mxc("b")]);
});

test("FAILURE: a booru 4xx STOPS the reader -- red, naming the fix -- and nothing more is pushed", async () => {
  const s = synapse({ head: 20, events: [img(10, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  b.next.push(new PushRejected("POST /fourier_jail/release.json answered 403. BOORU_PLACEMENTS_LOGIN / BOORU_PLACEMENTS_API_KEY ..."));
  assert.equal(await r.step(), null);
  const h = r.health({ detail: true });
  assert.equal(h.level, "red");
  assert.match(h.detail, /STOPPED: .*BOORU_PLACEMENTS_LOGIN/);
  assert.match(r.health().detail, /STOPPED: see the service log/, "the fix's text is for the box and the tailnet only");
  const snaps = s.w.snapshots;
  assert.equal(await r.step(), null);
  assert.equal(s.w.snapshots, snaps, "a stopped reader does not even read");
  assert.equal(b.pushes.length, 0);
});

test("FAILURE: a 4xx on the start-up cursor read stops it too; a 5xx there retries", async () => {
  const s = synapse({ head: 20 });
  const b = booru();
  b.cursorError = new PushRetryable("answered 503");
  const r = reader(s, b);
  assert.equal(await r.step(), 5000);
  b.cursorError = new PushRejected("answered 404. deploy chanbooru");
  assert.equal(await r.step(), null);
  assert.equal(r.health().level, "red");
});

test("FAILURE: a poisoned event is bisected down to itself and pushed in skipped; both sides of it are pushed", async () => {
  const s = synapse({
    head: 40,
    events: [img(3, "a"), img(17, "p", { id: "$poison", poison: true }), img(18, "b"), img(39, "c")],
  });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  await r.step();
  const p = livePushes(b)[0];
  assert.deepEqual(p.skipped, [{ stream_ordering: 17, event_id: "$poison", reason: "unreadable_event:22P02" }]);
  assert.deepEqual(p.mxcs.map((m) => m.mxc), [mxc("a"), mxc("b"), mxc("c")]);
  assert.equal(p.to, 40);
  const h = r.health({ detail: true });
  assert.equal(h.skipped.count, 1);
  assert.equal(h.skipped.recent[0].event_id, "$poison");
  assert.deepEqual(r.health().skipped, { count: 1, distinct: 1, redactions: 0 }, "event ids only with detail");
  assert.equal(r.health().level, "amber", "a skipped event is an answer the booru does not have: amber, not green");
});

test("FAILURE: an image whose answer fails with a data error is skipped by its events; the rest is pushed", async () => {
  const s = synapse({ head: 10, events: [img(2, "bad"), img(4, "good"), img(6, "bad")] });
  s.w.answerFail[mxc("bad")] = dataError();
  const b = booru({ cursor: parked });
  await reader(s, b).step();
  const p = livePushes(b)[0];
  assert.deepEqual(p.mxcs.map((m) => m.mxc), [mxc("good")]);
  assert.deepEqual(p.skipped.map((x) => [x.stream_ordering, x.reason]), [[2, "answer_failed:22P02"], [6, "answer_failed:22P02"]]);
});

test("FAILURE: an answer that fails for any other reason abandons the page (it is the database, not the row)", async () => {
  const s = synapse({ head: 10, events: [img(2, "x")] });
  s.w.answerFail[mxc("x")] = Object.assign(new Error("permission denied for table redactions"), { code: "42501" });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  assert.equal(await r.step(), 5000);
  assert.equal(b.pushes.length, 0);
  assert.equal(r.state().live, 0);
});

test("paging: the window bounds a page, the row limit cuts at the last row read", async () => {
  const events = [];
  for (let so = 1; so <= 9; so++) events.push(img(so, `m${so}`));
  const s = synapse({ head: 100, events });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { windowIds: 50, rowLimit: 4 });
  await r.step();
  assert.deepEqual(livePushes(b).map((p) => [p.from, p.to, p.mxcs.length]), [[0, 4, 4]], "four rows, cut at the fourth");
  await r.step();
  await r.step();
  assert.deepEqual(livePushes(b).map((p) => [p.from, p.to]), [[0, 4], [4, 8], [8, 58]], "then the 50-id window bounds it");
  assert.equal(r.state().caughtUp, false);
});

test("paging: a page stops at maxMxcs distinct images, at an event boundary, and repeats of an included image ride along", async () => {
  const s = synapse({ head: 20, events: [img(1, "a"), img(2, "b"), img(3, "a"), img(5, "c"), img(6, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxMxcs: 2 });
  await r.step();
  const p = livePushes(b)[0];
  assert.deepEqual(p.mxcs.map((m) => [m.mxc, m.newest_ordering]), [[mxc("a"), 3], [mxc("b"), 2]]);
  assert.equal(p.to, 4, "cut just before the third image's first event");
  await r.step();
  assert.deepEqual(livePushes(b)[1].mxcs.map((m) => [m.mxc, m.newest_ordering]), [[mxc("c"), 5], [mxc("a"), 6]]);
});

test("paging: a page stops at maxRoomEntries -- but always carries its first image, however many rooms", async () => {
  const s = synapse({
    head: 20,
    events: [img(1, "huge"), img(2, "small"), img(3, "more")],
    rooms: { [mxc("huge")]: ["!1", "!2", "!3", "!4", "!5", "!6"], [mxc("small")]: ["!a"], [mxc("more")]: ["!b"] },
  });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxRoomEntries: 5 });
  await r.step();
  assert.deepEqual(livePushes(b).map((p) => [p.to, p.mxcs.map((m) => m.mxc)]), [[1, [mxc("huge")]]]);
  await r.step();
  assert.deepEqual(livePushes(b)[1].mxcs.map((m) => m.mxc), [mxc("small"), mxc("more")]);
});

test("out of order: once caught up, an event that commits BELOW the cursor is found and asked in the next poll", async () => {
  const s = synapse({ head: 50, events: [img(40, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  await r.step();
  assert.equal(r.state().live, 50);
  // Ordering 45 was allocated before 50 but committed after it.
  s.w.events.push(img(45, "late"));
  await r.step();
  const last = livePushes(b).at(-1);
  assert.deepEqual(last.mxcs.map((m) => [m.mxc, m.newest_ordering]), [[mxc("late"), 45]]);
  // And only once.
  const n = b.pushes.length;
  await r.step();
  assert.equal(b.pushes.length, n);
});

test("heartbeat: an empty page moves the booru's cursor at most once a minute", async () => {
  const s = synapse({ head: 10 });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  await r.step();
  assert.equal(b.pushes.length, 1, "the first empty page is pushed (the booru learns where live is)");
  s.w.head = 20; s.w.clock += 2000;
  await r.step();
  assert.equal(b.pushes.length, 1);
  assert.equal(r.state().live, 20, "the reader's own position moved");
  s.w.head = 30; s.w.clock += 60_000;
  await r.step();
  assert.deepEqual(livePushes(b).map((p) => [p.from, p.to]), [[0, 10], [20, 30]]);
});

test("sweep: lap 1 starts below the tail (negative orderings included), is paced across the lap, and ends", async () => {
  const s = synapse({ head: 100, tail: -50, events: [img(-40, "backfill"), img(60, "old")] });
  const b = booru({ cursor: { live: 100, sweep: null, lap_started_at: null } });
  const r = reader(s, b, { windowIds: 100, lapHours: 1 });
  await r.step();
  const sweeps = () => b.pushes.map((p) => p.placements).filter((p) => p.stream === "sweep");
  assert.deepEqual(sweeps().map((p) => [p.from, p.to, p.mxcs.map((m) => m.mxc)]), [[-51, 49, [mxc("backfill")]]]);
  // The next page is due when the lap is (49+51)/(100+51) through its hour.
  s.w.clock += 60_000;
  await r.step();
  assert.equal(sweeps().length, 1, "not due yet");
  s.w.clock += 40 * 60_000;
  await r.step();
  assert.deepEqual(sweeps().map((p) => [p.from, p.to]), [[-51, 49], [49, 100]]);
  assert.equal(r.health({ detail: true }).sweep.lap, 2, "lap 1 done");
  assert.match(r.health({ detail: true }).detail, /sweep lap 2/);
  s.w.clock += 10 * 60_000;
  await r.step();
  assert.equal(sweeps().length, 2, "the next lap waits for the hour");
  s.w.clock += 10 * 60_000;
  await r.step();
  assert.equal(sweeps().length, 3);
  assert.equal(sweeps()[2].from, -51, "lap 2 starts at the tail again");
});

test("sweep: never runs while the live cursor is behind", async () => {
  const events = [];
  for (let so = 1; so <= 5; so++) events.push(img(so * 10, `m${so}`));
  const s = synapse({ head: 1000, events });
  const b = booru({ cursor: { live: 0, sweep: null, lap_started_at: null } });
  const r = reader(s, b, { windowIds: 100 });
  await r.step();
  assert.ok(b.pushes.every((p) => p.placements.stream === "live"));
});

test("health: the fields the contract lists; red when the oldest unread event has waited over 5 minutes", async () => {
  const s = synapse({ head: 200000, events: [img(10, "a"), { so: 60000, id: "$x", type: "m.room.member", received: 1_800_000_000_000 - 6 * 60_000 }] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  await r.step();
  const h = r.health({ detail: true });
  assert.equal(h.id, "gate3-reader");
  for (const k of ["live_cursor", "synapse_head", "lag_ids", "lag_seconds", "newest_pushed", "sweep", "last_push", "skipped"]) assert.ok(k in h, k);
  assert.equal(h.live_cursor, 50000);
  assert.equal(h.synapse_head, 200000);
  assert.equal(h.lag_ids, 150000);
  assert.equal(h.lag_seconds, 360);
  assert.equal(h.level, "red");
  assert.equal(h.newest_pushed.ordering, 10);
  assert.equal(h.last_push.ok, true);
});

test("health: green when caught up; red when no cycle has completed for 5 minutes; amber before the first", async () => {
  const s = synapse({ head: 10, events: [img(5, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  assert.equal(r.health().level, "amber");
  await r.step();
  assert.equal(r.health().level, "green");
  assert.equal(r.health({ detail: true }).lag_seconds, 0);
  s.w.fail = outage();
  s.w.clock += 6 * 60_000;
  await r.step();
  assert.equal(r.health().level, "red");
  assert.match(r.health({ detail: true }).detail, /no cycle has completed for 360 s/);
  assert.equal(r.health().detail, "no cycle has completed for over 5 minutes; see the service log");
});

test("a redaction reaches the IMAGE at once: every live answer clears the image gate's cache, before the push; the sweep's do not", async () => {
  const s = synapse({ head: 30, tail: 1, events: [img(10, "gone", { id: "$post" }), { so: 20, id: "$red", type: "m.room.redaction", redacts: "$post" }] });
  const b = booru({ cursor: { live: 15, sweep: null, lap_started_at: null } });
  const forgotten = [];
  const order = [];
  b.push = (orig => async (body) => { order.push(`push:${body.placements.stream}`); return orig(body); })(b.push);
  const r = reader(s, b, {}, { onLiveAnswers: async (mxcs) => { forgotten.push(...mxcs); order.push("forget"); } });
  await r.step();
  assert.deepEqual(forgotten, [mxc("gone")], "the live page's image only; the sweep page answered it too and cleared nothing");
  assert.deepEqual(order, ["forget", "push:live", "push:sweep"]);
});

test("a cache that cannot be cleared is said loudly and does not stop the push", async () => {
  const s = synapse({ head: 30, events: [img(10, "a")] });
  const b = booru({ cursor: parked });
  const said = [];
  const r = createPlacementsReader({
    withSnapshot: s.withSnapshot, booru: b, homeserverName: HS, now: () => s.w.clock,
    log: { log: () => {}, error: (m) => said.push(m) },
    onLiveAnswers: async () => { throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" }); },
  });
  assert.equal(await r.step(), 2000);
  assert.equal(livePushes(b).length, 1);
  assert.ok(said.some((m) => /could not clear the image gate's cached facts .*ECONNREFUSED.*up to 6 h/.test(m)), said.join("\n"));
});

test("isDataError and parseMxc: only SQLSTATE class 22 is a row's fault; only a well-formed mxc is an image", () => {
  assert.equal(isDataError({ code: "22P02" }), true);
  assert.equal(isDataError({ code: "22023" }), true);
  assert.equal(isDataError({ code: "57014" }), false);
  assert.equal(isDataError({ code: "ECONNREFUSED" }), false);
  assert.equal(isDataError(new Error("x")), false);
  assert.deepEqual(parseMxc("mxc://41chan.net/AbC_1-2"), { serverName: "41chan.net", mediaId: "AbC_1-2" });
  for (const bad of [null, "", "https://x/y", "mxc://41chan.net/a/b", "mxc://41chan.net/", "mxc://41chan.net/a b"]) assert.equal(parseMxc(bad), null, bad);
});

// -- review 2026-10-15: guards that survived mutation, now pinned ------------

test("the reader's pool is its own: two connections, a five-second statement timeout (GATE3_CONTRACTS.md A2)", () => {
  let cfg;
  const handlers = {};
  class FakePool { constructor(c) { cfg = c; } on(ev, f) { handlers[ev] = f; } }
  readerPool({ SYNAPSE_DB_HOST: "h", SYNAPSE_DB_PORT: "5433", SYNAPSE_DB_NAME: "synapse", SYNAPSE_DB_USER: "ro", SYNAPSE_DB_PASSWORD: "pw" }, { Pool: FakePool, log: quiet });
  assert.equal(cfg.max, 2);
  assert.equal(cfg.statement_timeout, 5000);
  assert.equal(cfg.port, 5433);
  assert.equal(cfg.application_name, "fourier-auth-gate3-reader");
  assert.equal(typeof handlers.error, "function", "an idle client's error is logged, not an uncaught crash");
});

test("out of order: a page cut INSIDE the late rows leaves the rest of them unprocessed, and the next poll asks them", async () => {
  const s = synapse({ head: 50, events: [img(40, "a")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxMxcs: 1 });
  await r.step();
  // Two late commits below the cursor; the page holds one distinct image.
  s.w.events.push(img(45, "late1"), img(46, "late2"));
  await r.step();
  await r.step();
  assert.deepEqual(livePushes(b).flatMap((p) => p.mxcs.map((m) => m.mxc)), [mxc("a"), mxc("late1"), mxc("late2")]);
});

test("FAILURE: a poisoned event past where the page was cut goes once, in the page that reaches it -- never early, never twice", async () => {
  const s = synapse({ head: 40, events: [img(3, "a"), img(5, "b"), img(17, "p", { id: "$poison", poison: true }), img(30, "c")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxMxcs: 1 });
  for (let i = 0; i < 4; i++) await r.step();
  const skips = livePushes(b).flatMap((p) => p.skipped.map((x) => [x.stream_ordering, p.from, p.to]));
  assert.equal(skips.length, 1, `reported exactly once: ${JSON.stringify(skips)}`);
  const [[so, from, to]] = skips;
  assert.ok(from < so && so <= to, "inside the range of the page that carried it");
});

test("sweep: a lap's first and last pages are pushed even empty and inside the heartbeat -- the booru learns where a lap starts and ends", async () => {
  const s = synapse({ head: 100, tail: -50 });
  const b = booru({ cursor: { live: 100, sweep: null, lap_started_at: null } });
  const r = reader(s, b, { windowIds: 100, lapHours: 0.01 }); // a 36 s lap
  const sweeps = () => b.pushes.map((p) => p.placements).filter((p) => p.stream === "sweep").map((p) => [p.from, p.to]);
  await r.step();
  assert.deepEqual(sweeps(), [[-51, 49]], "lap 1's first page, empty, pushed");
  s.w.clock += 24_000; // due at (49+51)/151 of the lap
  await r.step();
  assert.deepEqual(sweeps(), [[-51, 49], [49, 100]], "the last page, empty, 24 s after the first: pushed");
  s.w.clock += 13_000; // lap 2 is due
  await r.step();
  assert.deepEqual(sweeps().at(-1), [-51, 49], "lap 2's first page, 13 s after the last: pushed");
});

test("start: a booru live cursor AHEAD of Synapse's head is kept, not clamped, and said -- amber until the head passes it", async () => {
  const s = synapse({ head: 100, events: [img(50, "a")] });
  const said = [];
  const b = booru({ cursor: { live: 500, sweep: 10_000_000, lap_started_at: s.w.clock } });
  const r = createPlacementsReader({ withSnapshot: s.withSnapshot, booru: b, homeserverName: HS, now: () => s.w.clock, log: { log: () => {}, error: (m) => said.push(m) } });
  await r.step();
  assert.equal(r.state().live, 500, "the booru's cursor: a booru that holds it has pushes up to it");
  assert.ok(said.some((m) => /live cursor 500 is AHEAD of Synapse's head 100/.test(m)), said.join("\n"));
  assert.equal(r.health().level, "amber");
  assert.match(r.health({ detail: true }).detail, /live 500 of 100 .*ahead of Synapse's head/);
  s.w.head = 600;
  s.w.events.push(img(550, "b"));
  await r.step();
  assert.equal(r.health().level, "green", "the head passed it");
});

test("health: without detail access, the level, a fixed phrase and the skipped counts -- no cursor, head, lag, placement or sweep position (F-G5)", async () => {
  const s = synapse({ head: 15610, tail: -300, events: [img(15550, "abc")] });
  const b = booru({ cursor: { live: 15500, sweep: null, lap_started_at: null } });
  const r = reader(s, b);
  await r.step();
  const pub = r.health();
  assert.deepEqual(Object.keys(pub).sort(), ["detail", "id", "label", "level", "skipped"]);
  assert.equal(pub.level, "green");
  assert.equal(pub.detail, "running");
  assert.deepEqual(pub.skipped, { count: 0, distinct: 0, redactions: 0 });
  assert.doesNotMatch(JSON.stringify(pub), /15610|15550|15500|-301|T\d\d:\d\d/);
  const full = r.health({ detail: true });
  assert.equal(full.synapse_head, 15610);
  assert.equal(full.newest_pushed.ordering, 15550);
  assert.equal(full.sweep.position, 15610);
  assert.equal(full.last_push.to, 15610);
});

test("skipped: counted per DISTINCT event -- the sweep meeting the same unreadable row each lap is one loss, not one a lap; a redaction is named", async () => {
  const s = synapse({ head: 1000, tail: 1, events: [img(10, "a"), { so: 20, id: "$badred", type: "m.room.redaction", redacts: "$x", poison: true }] });
  const b = booru({ cursor: { live: 1000, sweep: null, lap_started_at: null } });
  const r = reader(s, b, { lapHours: 0.001 }); // a 3.6 s lap
  for (let i = 0; i < 3; i++) { await r.step(); s.w.clock += 4000; }
  const occurrences = b.pushes.flatMap((p) => p.placements.skipped);
  assert.ok(occurrences.length >= 3, `met every lap: ${occurrences.length}`);
  assert.ok(occurrences.every((x) => x.reason === "unreadable_redaction:22P02"));
  const pub = r.health();
  assert.deepEqual(pub.skipped, { count: occurrences.length, distinct: 1, redactions: 1 });
  assert.equal(pub.level, "amber");
  assert.match(pub.detail, /1 event\(s\) skipped, 1 of them redactions \(a deleted post may stay visible\)/);
  const full = r.health({ detail: true });
  assert.equal(full.skipped.recent.length, 1);
  assert.equal(full.skipped.recent[0].event_id, "$badred");
  assert.equal(full.skipped.recent[0].times, occurrences.length);
});

test("skipped: past maxDistinctSkipped the ids stop being kept but the distinct count does not stop", async () => {
  const s = synapse({ head: 40, events: [img(5, "p1", { id: "$p1", poison: true }), img(15, "p2", { id: "$p2", poison: true }), img(25, "ok")] });
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxDistinctSkipped: 1 });
  await r.step();
  const full = r.health({ detail: true });
  assert.equal(full.skipped.distinct, 2);
  assert.equal(full.skipped.unlisted, 1);
  assert.deepEqual(full.skipped.recent.map((x) => x.event_id), ["$p1"]);
});

test("the booru's cursor is re-read on every push: one that did not advance is amber and named -- and not adopted", async () => {
  const s = synapse({ head: 20, events: [img(10, "a")] });
  const said = [];
  const b = booru({ cursor: parked });
  b.answer = (p, held) => ({ ...held, live: 3 });
  const r = createPlacementsReader({ withSnapshot: s.withSnapshot, booru: b, homeserverName: HS, now: () => s.w.clock, log: { log: () => {}, error: (m) => said.push(m) } });
  await r.step();
  assert.equal(r.state().live, 20, "the reader keeps its own position: adopting a booru that never advances would re-read one range forever");
  const h = r.health({ detail: true });
  assert.equal(h.level, "amber");
  assert.equal(h.booru_cursor_disagrees.live.booru, 3);
  assert.equal(h.booru_cursor_disagrees.live.reader, 20);
  assert.match(r.health().detail, /the booru's cursor disagrees with the reader's/);
  assert.ok(said.some((m) => /answered live cursor 3 after a push ending at 20: the booru did not advance/.test(m)), said.join("\n"));
  b.answer = null;
  s.w.events.push(img(25, "b"));
  s.w.head = 30;
  await r.step();
  assert.equal(r.health().level, "green", "agreeing again clears it");
});

test("sweep: a booru that keeps only the HIGHEST sweep cursor did not take the lap's restart -- amber, naming what a restart would lose", async () => {
  const s = synapse({ head: 100, tail: -50, events: [img(-40, "backfill"), img(60, "old")] });
  const said = [];
  const b = booru({ cursor: { live: 100, sweep: null, lap_started_at: null } });
  let top = -Infinity;
  b.answer = (p, held) => { if (p.stream === "sweep") top = Math.max(top, p.to); return { ...held, sweep: top === -Infinity ? null : top }; };
  const r = createPlacementsReader({ withSnapshot: s.withSnapshot, booru: b, homeserverName: HS, now: () => s.w.clock, log: { log: () => {}, error: (m) => said.push(m) }, options: { windowIds: 100, lapHours: 1 } });
  await r.step();
  s.w.clock += 41 * 60_000;
  await r.step();
  assert.equal(r.health().level, "green", "lap 1 agreed");
  s.w.clock += 20 * 60_000;
  await r.step();
  assert.equal(r.health().level, "amber");
  assert.equal(r.health({ detail: true }).booru_cursor_disagrees.sweep.booru, 100);
  assert.ok(said.some((m) => /did not take this lap's restart from the tail/.test(m)), said.join("\n"));
});

test("stale: one reader's snapshots only get newer, so a stale answer is another writer -- amber for five minutes after the last", async () => {
  const s = synapse({ head: 20, events: [img(10, "a")] });
  const b = booru({ cursor: parked });
  b.stale = 1;
  const r = reader(s, b);
  await r.step();
  assert.equal(r.health().level, "amber");
  assert.match(r.health().detail, /the booru answered stale/);
  assert.equal(r.health({ detail: true }).stale.total, 1);
  b.stale = 0;
  s.w.clock += 5 * 60_000 + 1;
  await r.step();
  assert.equal(r.health().level, "green");
});

test("FAILURE: one image hitting the statement timeout is asked once more, then skipped as answer_timeout -- the page and the cursor go on", async () => {
  const s = synapse({ head: 10, events: [img(2, "slow"), img(4, "good"), img(6, "flaky")] });
  s.w.answerFail[mxc("slow")] = timeout();
  let flaky = 0;
  s.w.answerFail[mxc("flaky")] = () => (flaky++ === 0 ? timeout() : null);
  const b = booru({ cursor: parked });
  const r = reader(s, b);
  assert.equal(await r.step(), 2000);
  const p = livePushes(b)[0];
  assert.deepEqual(p.mxcs.map((m) => m.mxc), [mxc("good"), mxc("flaky")], "a timeout that clears on the second ask is answered");
  assert.deepEqual(p.skipped.map((x) => [x.stream_ordering, x.reason]), [[2, "answer_timeout"]]);
  assert.equal(r.state().live, 10);
  assert.equal(s.w.asked.filter((a) => a[0] === "rooms" && a[1] === mxc("slow")).length, 2, "asked twice, not forever");
});

test("FAILURE: more images timing out in one page than maxAnswerTimeouts is the database -- the page is abandoned and retried", async () => {
  const s = synapse({ head: 10, events: [img(2, "s1"), img(4, "s2")] });
  s.w.answerFail[mxc("s1")] = timeout();
  s.w.answerFail[mxc("s2")] = timeout();
  const b = booru({ cursor: parked });
  const r = reader(s, b, { maxAnswerTimeouts: 1 });
  assert.equal(await r.step(), 5000);
  assert.equal(b.pushes.length, 0);
  assert.equal(r.state().live, 0);
});

test("FAILURE: a booru 4xx on a SWEEP push stops the whole reader too -- its own backoff is for Synapse and booru 5xx only", async () => {
  const s = synapse({ head: 1000, tail: -50, events: [img(-40, "backfill")] });
  const b = booru({ cursor: { live: 1000, sweep: null, lap_started_at: null } });
  const real = b.push;
  b.push = async (body) => {
    if (body.placements.stream === "sweep") throw new PushRejected("POST /fourier_jail/release.json answered 403. BOORU_PLACEMENTS_LOGIN ...");
    return real(body);
  };
  const r = reader(s, b);
  assert.equal(await r.step(), null);
  assert.equal(r.health().level, "red");
  assert.equal(r.health().detail, "STOPPED: see the service log");
});

test("FAILURE: a sweep page that cannot be read backs off the SWEEP only -- the live poll goes on at 2 s, amber, and the sweep retries", async () => {
  const s = synapse({ head: 1000, tail: -50, events: [img(-40, "backfill")] });
  const b = booru({ cursor: { live: 1000, sweep: null, lap_started_at: null } });
  const r = reader(s, b);
  let sweepReads = 0;
  s.w.touchFail = (from) => (from < 0 ? (sweepReads++, outage()) : null);
  assert.equal(await r.step(), 2000, "the live poll's pace, not the backoff's");
  assert.equal(sweepReads, 1);
  assert.equal(r.health().level, "amber");
  assert.match(r.health().detail, /the sweep is retrying/);
  assert.match(r.health({ detail: true }).detail, /sweep: Synapse's database could not be read for the sweep page \(ECONNREFUSED\)/);
  s.w.events.push(img(1010, "new"));
  s.w.head = 1020;
  s.w.clock += 2000;
  assert.equal(await r.step(), 2000);
  assert.deepEqual(livePushes(b).at(-1).mxcs.map((m) => m.mxc), [mxc("new")], "live still reads and pushes");
  assert.equal(sweepReads, 1, "the sweep is not retried inside its 5 s backoff");
  assert.ok(!b.pushes.some((p) => p.placements.stream === "sweep"));
  s.w.touchFail = null;
  s.w.clock += 5000;
  await r.step();
  assert.ok(b.pushes.some((p) => p.placements.stream === "sweep" && p.placements.mxcs.some((m) => m.mxc === mxc("backfill"))));
  assert.equal(r.health().level, "green");
});

// -- the booru client --------------------------------------------------------

function fakeAxios(responses) {
  const calls = [];
  return {
    calls,
    request: async (cfg) => {
      calls.push(cfg);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const cursorOk = { status: 200, data: { cursor: { live: 15600, sweep: -210145, lap_started_at: 1792026850598 } } };

test("booru client: Basic auth as the gate account, never a key in the URL; GET ?placements=cursor; POST the body as given", async () => {
  const ax = fakeAxios([cursorOk, { status: 200, data: { cursor: cursorOk.data.cursor, applied: 1, stale: 0 } }]);
  const c = placementsBooruClient({ axios: ax, baseUrl: "http://danbooru:3000/", login: "gate", apiKey: "s3cret" });
  assert.deepEqual(await c.getCursor(), { live: 15600, sweep: -210145, lap_started_at: 1792026850598 });
  const body = { placements: { stream: "live", from: 1, to: 2, snapshot: { head: 2, at: 3 }, mxcs: [], skipped: [] } };
  assert.deepEqual(await c.push(body), { cursor: cursorOk.data.cursor, applied: 1, stale: 0 });
  const [get, post] = ax.calls;
  assert.equal(get.method, "get");
  assert.equal(get.url, "http://danbooru:3000/fourier_jail/release.json");
  assert.deepEqual(get.params, { placements: "cursor" });
  assert.equal(post.method, "post");
  assert.equal(post.url, "http://danbooru:3000/fourier_jail/release.json");
  assert.equal(post.data, body);
  for (const call of ax.calls) {
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from("gate:s3cret").toString("base64")}`);
    assert.doesNotMatch(JSON.stringify([call.url, call.params || {}]), /s3cret|api_key|login/);
    assert.equal(call.maxRedirects, 0);
  }
});

test("booru client: 5xx, 408, 429 and network are retryable; 401/403 name the account fix; other 4xx and a wrong shape say deploy chanbooru", async () => {
  const mk = (r) => placementsBooruClient({ axios: fakeAxios([r]), baseUrl: "http://danbooru:3000", login: "gate", apiKey: "k" });
  for (const r of [{ status: 502 }, { status: 408 }, { status: 429 }, Object.assign(new Error("x"), { code: "ECONNREFUSED" })]) {
    await assert.rejects(mk(r).push({ placements: {} }), PushRetryable);
  }
  await assert.rejects(mk({ status: 403, data: { message: "Access denied" } }).push({}), (e) =>
    e instanceof PushRejected && /BOORU_PLACEMENTS_LOGIN/.test(e.message) && /fourier_jail:create/.test(e.message) && /Access denied/.test(e.message));
  await assert.rejects(mk({ status: 422 }).push({}), (e) => e instanceof PushRejected && /deploy chanbooru/.test(e.message));
  await assert.rejects(mk({ status: 302 }).getCursor(), PushRejected);
  await assert.rejects(mk({ status: 200, data: { generation: "x", posts: [] } }).getCursor(), (e) => e instanceof PushRejected && /deploy chanbooru/.test(e.message));
  await assert.rejects(mk({ status: 200, data: { cursor: { live: "12" } } }).getCursor(), PushRejected);
  await assert.rejects(mk({ status: 200, data: { cursor: {}, applied: "1", stale: 0 } }).push({}), PushRejected);
  assert.deepEqual(await mk({ status: 200, data: { cursor: {} } }).getCursor(), { live: null, sweep: null, lap_started_at: null });
});
