"use strict";

// The sampling console's door (operator ruling 2026-10-09): pass, fail,
// users_default, membership, missing and malformed config, a database that
// cannot answer, and the 15 s cache. The SQL itself is in mediaauth-sql.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSampleGate, parseSampleGateConfig, powerLevelOf, whoCanRaise, STATE_TTL_MS } = require("./sample-gate");

const ROOM = "!GgCWjVAknxPyofQtCQ:41chan.net";
const ENV = { SAMPLE_GATE_ROOM: ROOM, SAMPLE_GATE_LEVEL: "70" };
const SABER = "@saber:41chan.net", MOD = "@maple:41chan.net", GONE = "@gone:41chan.net", CM = "@cm:41chan.net";

// The real room as read on 2026-10-09, trimmed, plus a content moderator at 70
// and a user who left with a level still recorded.
const STATE = {
  powerLevels: {
    users: { [SABER]: 100, [MOD]: 50, [CM]: 70, [GONE]: 90 },
    users_default: 0,
    state_default: 50,
    events: { "m.room.power_levels": 100 },
  },
  name: "modsmodsmods",
  joined: [CM, MOD, SABER],
};

const quiet = { error: () => {} };
function gate({ env = ENV, state = STATE, readRoom, clock } = {}) {
  const calls = { n: 0 };
  const g = createSampleGate({
    config: parseSampleGateConfig(env),
    readRoom: readRoom || (async (room) => { calls.n++; assert.equal(room, ROOM); return state; }),
    now: clock || (() => 0),
    log: quiet,
  });
  return { g, calls };
}

test("pass: saber at 100 and a content moderator at exactly 70 -> 204, internal view, identity", async () => {
  const { g } = gate();
  for (const who of [SABER, CM]) {
    const r = await g.answer(who);
    assert.equal(r.status, 204, who);
    assert.equal(r.headers["X-Fourier-View"], "internal");
    assert.equal(r.headers["X-Fourier-Identity"], who);
    assert.equal(r.body, undefined);
  }
});

test("fail: a joined moderator at 50 -> 403 naming the room, the level, theirs, and who can raise it", async () => {
  const { g } = gate();
  const r = await g.answer(MOD);
  assert.equal(r.status, 403);
  assert.equal(r.headers["X-Fourier-View"], undefined, "a refusal carries no view");
  assert.equal(r.headers["X-Fourier-Identity"], undefined);
  assert.match(r.body, /"modsmodsmods" \(!GgCWjVAknxPyofQtCQ:41chan\.net\)/);
  assert.match(r.body, /power level 70 or above/);
  assert.match(r.body, /@maple:41chan\.net is at power level 50 there/);
  assert.match(r.body, /Ask @saber:41chan\.net to raise you to 70/);
  assert.match(r.body, /^[\x00-\x7f]*$/, "ASCII");
});

test("membership: a level recorded for a user who LEFT does not open the door", async () => {
  const { g } = gate();
  const r = await g.answer(GONE);
  assert.equal(r.status, 403);
  assert.match(r.body, /is not joined to that room \(a level of 90 is recorded, but it counts only while joined\)/);
  assert.match(r.body, /for an invite/);
});

test("default: an unlisted joined user gets users_default; absent users_default is 0", async () => {
  const joinedStranger = { ...STATE, joined: [...STATE.joined, "@x:41chan.net"] };
  const open = { ...joinedStranger, powerLevels: { ...STATE.powerLevels, users_default: 70 } };
  assert.equal((await gate({ state: open }).g.answer("@x:41chan.net")).status, 204, "users_default 70 opens it");
  assert.equal((await gate({ state: joinedStranger }).g.answer("@x:41chan.net")).status, 403);
  const noDefault = { ...joinedStranger, powerLevels: { users: {} } };
  const r = await gate({ state: noDefault }).g.answer("@x:41chan.net");
  assert.equal(r.status, 403);
  assert.match(r.body, /at power level 0 there/);
});

test("powerLevelOf: the spec's lookup; string levels (old room versions) parse; garbage throws", () => {
  assert.equal(powerLevelOf({ users: { a: 75 } }, "a"), 75);
  assert.equal(powerLevelOf({ users: { a: "75" } }, "a"), 75);
  assert.equal(powerLevelOf({ users: {}, users_default: 5 }, "a"), 5);
  assert.equal(powerLevelOf({}, "a"), 0);
  assert.throws(() => powerLevelOf({ users: { a: "lots" } }, "a"));
  assert.throws(() => powerLevelOf({ users: { a: 70.5 } }, "a"));
  // A malformed level is an outage of the answer: 503, never a pass and never a level 0.
});

test("a malformed power level answers 503, not 403 and not 204", async () => {
  const bad = { ...STATE, powerLevels: { users: { [SABER]: "high" } } };
  const r = await gate({ state: bad }).g.answer(SABER);
  assert.equal(r.status, 503);
});

test("whoCanRaise: joined users at the level that changes m.room.power_levels", () => {
  assert.deepEqual(whoCanRaise(STATE.powerLevels, STATE.joined), [SABER]);
  // No events entry: state_default; none of that either: 50.
  assert.deepEqual(whoCanRaise({ users: { a: 50, b: 49 } }, ["a", "b"]), ["a"]);
});

test("no session -> 403 telling the viewer to sign in, without touching the database", async () => {
  const { g, calls } = gate();
  const r = await g.answer(null);
  assert.equal(r.status, 403);
  assert.match(r.body, /signed in/);
  assert.equal(calls.n, 0);
});

test("missing config fails CLOSED, names the variables and where to set them, even for saber", async () => {
  for (const env of [{}, { SAMPLE_GATE_ROOM: ROOM }, { SAMPLE_GATE_LEVEL: "70" }]) {
    const { g, calls } = gate({ env });
    const r = await g.answer(SABER);
    assert.equal(r.status, 503, JSON.stringify(env));
    assert.match(r.body, /SAMPLE_GATE_(ROOM|LEVEL) is unset/);
    assert.match(r.body, /docker-compose\.yaml/);
    assert.equal(calls.n, 0);
  }
});

test("malformed config fails CLOSED: a room that is not a room id, a level that is not an integer", async () => {
  for (const env of [
    { SAMPLE_GATE_ROOM: "modsmodsmods", SAMPLE_GATE_LEVEL: "70" },
    { SAMPLE_GATE_ROOM: ROOM, SAMPLE_GATE_LEVEL: "seventy" },
    { SAMPLE_GATE_ROOM: ROOM, SAMPLE_GATE_LEVEL: "70.5" },
  ]) {
    const r = await gate({ env }).g.answer(SABER);
    assert.equal(r.status, 503, JSON.stringify(env));
  }
  assert.deepEqual(parseSampleGateConfig(ENV), { ok: true, room: ROOM, level: 70 });
});

test("DB error fails CLOSED with 503 + Retry-After, the error code only (no address on the page)", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 172.18.0.5:5432"), { code: "ECONNREFUSED" });
  const { g } = gate({ readRoom: async () => { throw err; } });
  const r = await g.answer(SABER);
  assert.equal(r.status, 503);
  assert.equal(r.headers["Retry-After"], "30");
  assert.match(r.body, /ECONNREFUSED/);
  assert.doesNotMatch(r.body, /172\.18/);
  assert.equal(r.headers["X-Fourier-View"], undefined);
});

test("a room id this server does not hold fails CLOSED as misconfiguration, not as 'nobody qualifies'", async () => {
  const { g } = gate({ readRoom: async () => ({ powerLevels: null, name: null, joined: [] }) });
  const r = await g.answer(SABER);
  assert.equal(r.status, 503);
  assert.match(r.body, /SAMPLE_GATE_ROOM names a room this server does not hold/);
});

test("cache: one read serves 15 s of requests; the next read sees a demotion", async () => {
  let t = 0;
  let state = STATE;
  const reads = { n: 0 };
  const g = createSampleGate({
    config: parseSampleGateConfig(ENV),
    readRoom: async () => { reads.n++; return state; },
    now: () => t,
    log: quiet,
  });
  assert.equal(STATE_TTL_MS, 15_000);
  assert.equal((await g.answer(CM)).status, 204);
  for (let i = 0; i < 50; i++) await g.answer(CM);
  assert.equal(reads.n, 1, "fifty requests inside the window are one database read");
  state = { ...STATE, powerLevels: { ...STATE.powerLevels, users: { ...STATE.powerLevels.users, [CM]: 50 } } };
  t = STATE_TTL_MS - 1;
  assert.equal((await g.answer(CM)).status, 204, "still inside the window: the cached level");
  t = STATE_TTL_MS;
  assert.equal((await g.answer(CM)).status, 403, "the window over: the demotion shuts the door");
  assert.equal(reads.n, 2);
});

test("cache: an error is never cached, and concurrent misses share one read", async () => {
  let fail = true;
  let reads = 0;
  let release;
  const g = createSampleGate({
    config: parseSampleGateConfig(ENV),
    readRoom: async () => {
      reads++;
      if (fail) throw Object.assign(new Error("boom"), { code: "57P01" });
      await new Promise((r) => { release = r; });
      return STATE;
    },
    now: () => 0,
    log: quiet,
  });
  assert.equal((await g.answer(SABER)).status, 503);
  fail = false;
  const pending = [g.answer(SABER), g.answer(CM), g.answer(MOD)];
  await new Promise((r) => setImmediate(r));
  release();
  const out = await Promise.all(pending);
  assert.deepEqual(out.map((r) => r.status), [204, 204, 403]);
  assert.equal(reads, 2, "the failed read, then ONE shared read for three concurrent requests");
});

// -- Review repair 2026-10-09: a refusal is a page with the way back, and its
// remedy names the Technetium control that can actually set 70. --

// The no-cascade property (operator ruling 2026-10-09: "be absolutely sure
// that calling sample from within the booru from within sample doesn't cause
// a cascade"): ONE absolute link, to the booru, same frame -- nothing that
// opens, embeds or redirects to another surface. Technetium's own address is
// never a link: followed inside tc's centre panel it would nest tc in tc.
function assertWayBackPage(r, label) {
  assert.equal(r.headers["Content-Type"], "text/html; charset=utf-8", label);
  assert.equal(r.headers["Cache-Control"], "no-store", label);
  assert.equal(r.headers["X-Content-Type-Options"], "nosniff", label);
  assert.match(r.body, /^<!doctype html>/, label);
  const anchors = r.body.match(/<a\b[^>]*>/gi) || [];
  assert.deepEqual(anchors, ['<a href="https://booru.41chan.net/">'], label);
  assert.doesNotMatch(r.body, /target=|<script|<iframe|<frame|<object|<embed|<form|window\.open|http-equiv/i, label);
  assert.doesNotMatch(r.body, /href="https:\/\/tc\./, label);
  assert.match(r.body, /^[\x00-\x7f]*$/, `${label}: ASCII`);
}

test("every refusal is an HTML page carrying the way back to the booru, same frame", async () => {
  const cases = [
    ["no session", gate().g, null],
    ["level 50", gate().g, MOD],
    ["not joined", gate().g, GONE],
    ["not configured", gate({ env: {} }).g, SABER],
    ["db error", gate({ readRoom: async () => { throw Object.assign(new Error("x"), { code: "57P01" }); } }).g, SABER],
  ];
  for (const [label, g, who] of cases) {
    const r = await g.answer(who);
    assert.ok(r.status === 403 || r.status === 503, label);
    assertWayBackPage(r, label);
  }
});

test("the refusal page escapes what Synapse and the session hand it (a room name is anyone-with-50's text)", async () => {
  const evil = { ...STATE, name: '<img src=x onerror=alert(1)> & "co"' };
  const r = await gate({ state: evil }).g.answer(MOD);
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.body, /<img/);
  assert.match(r.body, /&lt;img src=x onerror=alert\(1\)&gt; &amp; "co"/);
  assertWayBackPage(r, "escaped");
});

test("the 403 remedy names the Technetium control that sets a level of 70, not just the number", async () => {
  // Technetium's profile card offers Member 0 / Voice 25 / Moderator 50 /
  // Owner 100 only; the bulk panel's free level box is the one control in the
  // only client that can enter 70 (technetium src/ui/BulkLevels.tsx).
  for (const who of [MOD, GONE]) {
    const r = await gate().g.answer(who);
    assert.equal(r.status, 403, who);
    assert.match(r.body, /Settings &gt; Server permissions &gt; Set a level in many rooms/, who);
    assert.match(r.body, /type 70 in the box after the named levels/, who);
    assert.match(r.body, /tick modsmodsmods/, who);
    assert.match(r.body, /Yes, set it/, who);
    assert.doesNotMatch(r.body, /Element|\/op /, who);
  }
  // Signed out is a sign-in problem, not a level problem: no level how-to.
  assert.doesNotMatch((await gate().g.answer(null)).body, /Server permissions/);
});
