"use strict";

// THE QUARANTINE DOCUMENT, as fourier-auth reads it (booru-quarantine.js).
// Operator rulings 2026-10-12: a flagged or banished tag's posts disappear
// everywhere, like jail -- including through this gate's Matrix door and its
// publication grants. The booru publishes the set at
// GET /fourier_jail/release.json?quarantine=1; these tests hold the reader to
// that contract and to fail-closed: no good read, or one too old, refuses.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  booruQuarantineClient, createQuarantine, QuarantineUnavailable,
  matrixDoorVerdict, quarantineConfigProblem, MAX_RESTARTS, STALE_MS, ALERT_MS,
} = require("./booru-quarantine");

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const MXC = "mxc://41chan.net/FlaggedMediaIdAAAAAAAAAA";

function doc(over = {}) {
  return { generation: "0123456789abcdef", flagged: null, banished: null, posts: [], next_after: null, ...over };
}

// pages(params, headers, n) -> { status, headers, data }
function fakeAxios(pages) {
  const calls = [];
  return {
    calls,
    get: async (url, cfg) => {
      calls.push({ url, cfg });
      return pages(cfg.params || {}, cfg.headers || {}, calls.length);
    },
  };
}
const ok = (data, etag = '"0123456789abcdef-p"') => ({ status: 200, headers: { etag }, data });

function client(ax) {
  return booruQuarantineClient({ axios: ax, baseUrl: "http://danbooru:3000/", login: "gate", apiKey: "k3y" });
}

// -- the client ---------------------------------------------------------------

test("one page: md5s and mxcs come back as sets; credentials ride in a Basic header, never the URL", async () => {
  const ax = fakeAxios(() => ok(doc({ posts: [
    { id: 1, md5: A, mxc: null, flagged: true, banished: false },
    { id: 2, md5: B, mxc: MXC, flagged: false, banished: true },
  ] })));
  const out = await client(ax)({});
  assert.equal(out.generation, "0123456789abcdef");
  assert.equal(out.etag, '"0123456789abcdef-p"');
  assert.deepEqual([...out.md5s].sort(), [A, B]);
  assert.deepEqual([...out.mxcs], [MXC]);
  const { url, cfg } = ax.calls[0];
  assert.equal(url, "http://danbooru:3000/fourier_jail/release.json");
  assert.equal(String(cfg.params.quarantine), "1");
  assert.equal(cfg.params.after, undefined);
  assert.equal(cfg.headers.Authorization, `Basic ${Buffer.from("gate:k3y").toString("base64")}`);
  assert.ok(!/k3y|gate/.test(url + JSON.stringify(cfg.params)), "no credential in the URL");
  assert.equal(cfg.maxRedirects, 0);
  assert.equal(cfg.validateStatus(500), true, "every status is read, none thrown by axios");
});

test("every row is refused whatever its flags say -- a flagged Matrix post included; nothing is opened", async () => {
  // The booru door's opening for a reviewer of a flagged Matrix post closed
  // 2026-10-15 (gate 3 on; review moved to sampling's jail panel). The read
  // carries the refused sets and nothing else.
  const D = "d".repeat(32);
  const E = "e".repeat(32);
  const F = "f".repeat(32);
  const ax = fakeAxios(() => ok(doc({ posts: [
    { id: 1, md5: A, mxc: MXC, flagged: true, banished: false },
    { id: 2, md5: B, mxc: "mxc://41chan.net/Banished", flagged: true, banished: true },
    { id: 3, md5: C, mxc: null, flagged: true, banished: false },
    { id: 4, md5: D, mxc: "mxc://41chan.net/JailedOnly", flagged: false, banished: false, jailed: true },
    { id: 5, md5: E, mxc: "mxc://41chan.net/Truthy", flagged: "yes", banished: false },
    { id: 6, md5: F, mxc: "mxc://41chan.net/FlaggedJailed", flagged: true, banished: false, jailed: true },
  ] })));
  const out = await client(ax)({});
  assert.deepEqual([...out.md5s], [A, B, C, D, E, F]);
  assert.deepEqual([...out.mxcs], [MXC, "mxc://41chan.net/Banished", "mxc://41chan.net/JailedOnly", "mxc://41chan.net/Truthy", "mxc://41chan.net/FlaggedJailed"]);
  assert.deepEqual(Object.keys(out).sort(), ["etag", "generation", "md5s", "mxcs"]);
  const q = createQuarantine({ fetchDoc: async () => out, now: () => 0, log: { error() {}, log() {} }, setTimer: () => ({ unref() {} }) });
  await q.poll();
  assert.equal(q.check({ md5: A }), "refuse");
  assert.equal(q.check({ mxc: MXC }), "refuse");
  assert.equal(q.reviewable, undefined, "no reviewer's opening is offered");
});

test("a post carrying only troll_jail is refused like any other row (jailed means deleted, shown nowhere)", async () => {
  const JAIL_MXC = "mxc://41chan.net/JailedOnlyMediaAAAAAAAAA";
  const ax = fakeAxios(() => ok(doc({ posts: [{ id: 9, md5: C, mxc: JAIL_MXC, flagged: false, banished: false, jailed: true }] })));
  const out = await client(ax)({});
  assert.deepEqual([...out.md5s], [C]);
  assert.deepEqual([...out.mxcs], [JAIL_MXC]);
  const q = createQuarantine({ fetchDoc: async () => out, now: () => 0, log: { error() {}, log() {} }, setTimer: () => ({ unref() {} }) });
  await q.poll();
  assert.equal(await matrixDoorVerdict({ quarantine: q, serverName: "41chan.net", mediaId: "JailedOnlyMediaAAAAAAAAA", md5s: [] }), "refuse");
});

test("the names in the document are ignored: fourier-auth holds no tag name", async () => {
  const ax = fakeAxios(() => ok(doc({ flagged: ["secret_flagged_name"], banished: ["secret_banished_name"], posts: [{ id: 1, md5: A, mxc: null }] })));
  const out = await client(ax)({});
  assert.ok(!JSON.stringify({ ...out, md5s: [...out.md5s], mxcs: [...out.mxcs] }).includes("secret_"));
});

test("paging: next_after is followed until null, and every page is merged", async () => {
  const ax = fakeAxios((params) => {
    if (params.after === undefined) return ok(doc({ posts: [{ id: 10, md5: A, mxc: null }], next_after: 10 }));
    if (params.after === 10) return ok(doc({ posts: [{ id: 20, md5: B, mxc: MXC }], next_after: 20 }));
    return ok(doc({ posts: [{ id: 30, md5: C, mxc: null }], next_after: null }));
  });
  const out = await client(ax)({ ifNoneMatch: '"old-p"' });
  assert.deepEqual([...out.md5s].sort(), [A, B, C]);
  assert.equal(ax.calls.length, 3);
  assert.equal(ax.calls[0].cfg.headers["If-None-Match"], '"old-p"', "the first page carries the ETag");
  assert.equal(ax.calls[1].cfg.headers["If-None-Match"], undefined, "later pages do not");
});

test("the generation changing between pages restarts from page 1", async () => {
  let gen = "1111111111111111";
  const ax = fakeAxios((params, _h, n) => {
    if (params.after === undefined) return ok(doc({ generation: gen, posts: [{ id: 1, md5: A, mxc: null }], next_after: 1 }));
    if (n === 2) { gen = "2222222222222222"; return ok(doc({ generation: gen, posts: [], next_after: null })); }
    return ok(doc({ generation: gen, posts: [{ id: 2, md5: B, mxc: null }], next_after: null }));
  });
  const out = await client(ax)({});
  assert.equal(out.generation, "2222222222222222");
  assert.deepEqual([...out.md5s].sort(), [A, B]);
  assert.equal(ax.calls.length, 4, "page 1, page 2 (changed), page 1 again, page 2");
});

test(`a generation that never holds still is unreadable after ${MAX_RESTARTS} restarts`, async () => {
  let n = 0;
  const ax = fakeAxios((params) => {
    n++;
    return ok(doc({ generation: String(n).padStart(16, "0"), posts: [], next_after: params.after === undefined ? 1 : null }));
  });
  await assert.rejects(() => client(ax)({}), /generation changed between pages/);
  assert.equal(ax.calls.length, (MAX_RESTARTS + 1) * 2);
});

test("304 to the ETag is { notModified }", async () => {
  const ax = fakeAxios(() => ({ status: 304, headers: {}, data: "" }));
  assert.deepEqual(await client(ax)({ ifNoneMatch: '"0123456789abcdef-p"' }), { notModified: true });
});

test("shape check: an older booru's answer is unreadable, and says to deploy chanbooru", async () => {
  // sample would get the jail-events body; anything without generation+posts.
  for (const data of [{ events: [], next_since: 5 }, [], "<html>", doc({ generation: 7 }), doc({ posts: null }), doc({ generation: "" })]) {
    const ax = fakeAxios(() => ok(data));
    await assert.rejects(() => client(ax)({}), /older than the quarantine build.*deploy chanbooru/, JSON.stringify(data));
  }
});

test("401 and 403 name the setting and the key", async () => {
  for (const status of [401, 403]) {
    const ax = fakeAxios(() => ({ status, headers: {}, data: { error: "x" } }));
    await assert.rejects(() => client(ax)({}), /fourier_quarantine_reader_names, or its api key is wrong/);
  }
});

// The booru's own refusal says WHICH fix applies -- above all the reader
// hardening (session ruling 2026-10-12): a listed account still at Member is
// refused with "an admin promotes it (Gold or above) at /admin/users/<id>/edit".
// Dropping that sentence logged "not on the list, or a wrong key" for an
// account that is on the list with the right key.
test("401 and 403 carry the booru's own reason, so a Member-level reader is told to have it promoted", async () => {
  const message = "gate is on fourier_quarantine_reader_names but is Member: a reader must be above Member ... an admin promotes it (Gold or above) at /admin/users/7/edit";
  const ax = fakeAxios(() => ({ status: 403, headers: {}, data: { success: false, error: "User::PrivilegeError", message } }));
  await assert.rejects(() => client(ax)({}), (err) => err.message.includes("/admin/users/7/edit") && err.message.includes("is Member"));
});

test("any other status, a malformed post, or a next_after that does not advance is unreadable -- never an empty set", async () => {
  const bad = [
    { status: 500, headers: {}, data: {} },
    { status: 302, headers: { location: "/login" }, data: "" },
    ok(doc({ posts: [{ id: 1, md5: "nothex", mxc: null }] })),
    ok(doc({ posts: [{ id: 1, md5: A, mxc: "https://not-an-mxc" }] })),
    ok(doc({ posts: [null] })),
    ok({ generation: "0123456789abcdef", posts: [] }), // no next_after at all
    ok(doc({ next_after: 0 })),
    ok(doc({ next_after: "5" })),
  ];
  for (const answer of bad) {
    const ax = fakeAxios(() => answer);
    await assert.rejects(() => client(ax)({}), Error, JSON.stringify(answer));
  }
  // A 304 to a read that sent no ETag is not an answer either.
  const ax = fakeAxios(() => ({ status: 304, headers: {}, data: "" }));
  await assert.rejects(() => client(ax)({}), /304/);
});

test("the booru unreachable is a thrown error naming where it was asked", async () => {
  const ax = { get: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } };
  await assert.rejects(() => client(ax)({}), /ECONNREFUSED/);
});

// -- the poller and check() ---------------------------------------------------

function harness({ answers, staleMs } = {}) {
  let t = 1_000_000;
  const logs = [];
  const asked = [];
  const q = createQuarantine({
    fetchDoc: async (opts) => {
      asked.push(opts);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
    now: () => t,
    pollMs: 30_000,
    ...(staleMs ? { staleMs } : {}),
    log: { error: (m) => logs.push(m), log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    setTimer: () => ({ unref() {} }),
  });
  return { q, logs, asked, advance: (ms) => { t += ms; } };
}
const read = (over = {}) => ({ generation: "0123456789abcdef", etag: '"0123456789abcdef-p"', md5s: new Set([A]), mxcs: new Set([MXC]), ...over });

test("before any good read, check() throws QuarantineUnavailable -- fail closed", async () => {
  const { q } = harness({ answers: [new Error("connect ECONNREFUSED")] });
  assert.throws(() => q.check({ md5: B }), QuarantineUnavailable);
  await q.poll();
  assert.throws(() => q.check({ md5: B }), (e) => e instanceof QuarantineUnavailable && /ECONNREFUSED/.test(e.message));
  assert.equal(q.health().level, "red");
});

test("after a good read: a listed md5 or mxc is refused, anything else allowed", async () => {
  const { q } = harness({ answers: [read()] });
  await q.poll();
  assert.equal(q.check({ md5: A, mxc: null }), "refuse");
  assert.equal(q.check({ md5: null, mxc: MXC }), "refuse");
  assert.equal(q.check({ md5: B, mxc: "mxc://41chan.net/other" }), "allow");
  assert.equal(q.health().generation, "0123456789abcdef");
  assert.equal(q.health().level, "green");
});

test("a 304 is a successful read: it refreshes the age and sends the last ETag", async () => {
  const { q, asked, advance } = harness({ answers: [read(), { notModified: true }, new Error("down")] });
  await q.poll();
  advance(170_000);
  await q.poll();
  assert.equal(asked[1].ifNoneMatch, '"0123456789abcdef-p"');
  advance(30_000); // 200 s after the first read, 30 s after the 304
  await q.poll(); // fails; the 304's age still holds
  assert.equal(q.check({ md5: A }), "refuse");
  assert.equal(q.health().level, "amber", "the last poll failed, under a minute since the last good read");
});

test("stale grace (operator ruling 2026-10-12): the last good document serves for 30 min, loud from the first minute, then refuses", async () => {
  assert.equal(STALE_MS, 30 * 60_000);
  assert.equal(ALERT_MS, 60_000);
  const fails = Array.from({ length: 80 }, () => new Error("booru answered 502"));
  const { q, advance, logs } = harness({ answers: [read(), ...fails] });
  await q.poll();
  advance(30_000);
  await q.poll();
  assert.equal(q.health().level, "amber", "one failed poll, 30 s since the good read");
  assert.equal(q.check({ md5: A }), "refuse");
  advance(31_000);
  await q.poll();
  const h = q.health();
  assert.equal(h.level, "red", "past the first minute the alert is loud");
  assert.match(h.reason, /serving on the last good document/);
  assert.match(h.reason, /502/);
  assert.match(h.reason, /30 min/);
  assert.ok(logs.some((l) => /STALE/.test(l) && /30 min/.test(l)), logs.join("\n"));
  assert.equal(logs.filter((l) => /STALE/.test(l)).length, 1, "the crossing is logged once, not every poll");
  // Still deciding on the last good document right up to the bound...
  advance(STALE_MS - 61_000 - 1);
  await q.poll();
  assert.equal(q.check({ md5: A }), "refuse");
  assert.equal(q.check({ md5: B }), "allow");
  // ...and past it, everything is refused (fail closed), naming the last failure.
  advance(2);
  assert.throws(() => q.check({ md5: B }), (e) => e instanceof QuarantineUnavailable && /502/.test(e.message) && /1800s/.test(e.message));
  assert.equal(q.health().level, "red");
});

test("stale grace: the booru returning ends the alert, and a tag flagged during the outage takes effect then", async () => {
  const { q, advance, logs } = harness({ answers: [read(), new Error("down"), new Error("down"), read({ generation: "fedcba9876543210", md5s: new Set([A, B]) })] });
  await q.poll();
  advance(40_000); await q.poll();
  advance(40_000); await q.poll();
  assert.equal(q.health().level, "red");
  assert.equal(q.check({ md5: B }), "allow", "the outage's flag is not known yet");
  advance(30_000); await q.poll();
  assert.equal(q.health().level, "green");
  assert.equal(q.check({ md5: B }), "refuse");
  assert.ok(logs.some((l) => /readable again/.test(l)));
});

test("a new generation replaces the sets: a released md5 is allowed on the next read", async () => {
  const { q } = harness({ answers: [read(), read({ generation: "fedcba9876543210", md5s: new Set(), mxcs: new Set() })] });
  await q.poll();
  assert.equal(q.check({ md5: A }), "refuse");
  await q.poll();
  assert.equal(q.check({ md5: A }), "allow");
});

test("logs carry counts and reasons, never an md5 or an mxc", async () => {
  const { q, logs } = harness({ answers: [new Error("first failure"), read(), new Error("second failure")] });
  await q.poll(); await q.poll(); await q.poll();
  const all = logs.join("\n");
  assert.ok(!all.includes(A) && !all.includes(MXC), all);
  assert.match(all, /first failure/);
  assert.match(all, /second failure/);
});

test("polls never overlap", async () => {
  let release;
  let calls = 0;
  const q = createQuarantine({
    fetchDoc: () => { calls++; return new Promise((r) => { release = () => r(read()); }); },
    now: () => 0, log: { error() {}, log() {} }, setTimer: () => ({ unref() {} }),
  });
  const p1 = q.poll();
  const p2 = q.poll();
  assert.equal(calls, 1);
  release();
  await Promise.all([p1, p2]);
  assert.equal(q.check({ md5: A }), "refuse");
});

test("a fetchDoc that throws synchronously does not wedge the poller", async () => {
  let n = 0;
  const q = createQuarantine({
    fetchDoc: () => { n++; if (n === 1) throw new Error("sync"); return Promise.resolve(read()); },
    now: () => 0, log: { error() {}, log() {} }, setTimer: () => ({ unref() {} }),
  });
  await q.poll();
  await q.poll();
  assert.equal(n, 2);
  assert.equal(q.check({ md5: A }), "refuse");
});

test("unset credentials: both variables are named, nothing is polled, every check throws", () => {
  assert.equal(quarantineConfigProblem({ login: "gate", apiKey: "k" }), null);
  for (const env of [{}, { login: "gate" }, { apiKey: "k" }]) {
    const p = quarantineConfigProblem(env);
    assert.match(p, /BOORU_QUARANTINE_LOGIN/);
    assert.match(p, /BOORU_QUARANTINE_API_KEY/);
  }
  const logs = [];
  let fetched = 0;
  const problem = quarantineConfigProblem({});
  const q = createQuarantine({ fetchDoc: async () => { fetched++; return read(); }, problem, log: { error: (m) => logs.push(m), log() {} }, setTimer: () => { throw new Error("no timer when unconfigured"); } });
  q.start();
  assert.equal(fetched, 0);
  assert.ok(logs.some((l) => /BOORU_QUARANTINE_LOGIN/.test(l) && /BOORU_QUARANTINE_API_KEY/.test(l)), "the boot log names both");
  assert.throws(() => q.check({ md5: B }), (e) => e instanceof QuarantineUnavailable && /BOORU_QUARANTINE_API_KEY/.test(e.message));
  assert.equal(q.health().level, "red");
});

test("start() polls at once and on an unref'd timer", async () => {
  let fetched = 0;
  let unrefd = false;
  let every = null;
  const q = createQuarantine({
    fetchDoc: async () => { fetched++; return read(); },
    now: () => 0, pollMs: 30_000, log: { error() {}, log() {} },
    setTimer: (fn, ms) => { every = ms; return { unref() { unrefd = true; } }; },
  });
  q.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched, 1);
  assert.equal(every, 30_000);
  assert.ok(unrefd);
});

// -- the Matrix door's verdict, callable without Express ----------------------

test("Matrix door: refused by mxc without even looking up the md5", async () => {
  const { q } = harness({ answers: [read()] });
  await q.poll();
  let looked = 0;
  const v = await matrixDoorVerdict({ quarantine: q, serverName: "41chan.net", mediaId: "FlaggedMediaIdAAAAAAAAAA", md5s: async () => { looked++; return []; } });
  assert.equal(v, "refuse");
  assert.equal(looked, 0);
});

test("Matrix door: refused by any md5 the image's file is known under", async () => {
  const { q } = harness({ answers: [read()] });
  await q.poll();
  assert.equal(await matrixDoorVerdict({ quarantine: q, serverName: "41chan.net", mediaId: "OtherMedia", md5s: async () => [B, A] }), "refuse");
  assert.equal(await matrixDoorVerdict({ quarantine: q, serverName: "41chan.net", mediaId: "OtherMedia", md5s: async () => [B] }), "allow");
  assert.equal(await matrixDoorVerdict({ quarantine: q, serverName: "matrix.org", mediaId: "Remote", md5s: [] }), "allow");
});

test("Matrix door: an unreadable quarantine throws before any md5 lookup", async () => {
  const { q } = harness({ answers: [] });
  let looked = 0;
  await assert.rejects(
    () => matrixDoorVerdict({ quarantine: q, serverName: "41chan.net", mediaId: "X", md5s: async () => { looked++; return []; } }),
    QuarantineUnavailable,
  );
  assert.equal(looked, 0);
});
