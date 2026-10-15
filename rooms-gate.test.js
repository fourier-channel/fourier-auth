"use strict";

// GET /verify?gate=rooms -- gate 3 for posts, GATE3_CONTRACTS.md A1: the
// 200/401/503 bodies, sorted rooms and their digest, no-store, the 10 s cache
// that never holds an empty set, coalescing, and the binding to the cookie's
// own MXID through verify.js. The SQL (current_state_events, a left room
// excluded) is in mediaauth-sql.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRoomsGate, roomsDigest, CACHE_KEY, CACHE_TTL_S } = require("./rooms-gate");
const { makeVerifyHandler } = require("./verify");

const ALICE = "@alice:41chan.net", BOB = "@bob:41chan.net";
const quiet = { error: () => {} };

function fakeCache() {
  const store = new Map();
  const sets = [];
  return {
    store, sets,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v, ttl) => { sets.push([k, v, ttl]); store.set(k, v); },
  };
}

function gate({ rooms = { [ALICE]: ["!b:41chan.net", "!a:41chan.net", "!C:41chan.net"] }, read, cache = fakeCache(), clock = () => 1792026850598 } = {}) {
  const calls = [];
  const g = createRoomsGate({
    readJoinedRooms: read || (async (mxid) => { calls.push(mxid); return rooms[mxid] || []; }),
    cacheGet: cache.get,
    cacheSet: cache.set,
    now: clock,
    log: quiet,
  });
  return { g, calls, cache };
}

test("200: the viewer's rooms, sorted by code unit, with count, digest and as_of; no-store; JSON", async () => {
  const { g } = gate();
  const r = await g.answer(ALICE);
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.headers["Content-Type"], "application/json; charset=utf-8");
  const body = JSON.parse(r.body);
  // Upper case sorts before lower in code-unit order; a collation-aware ORDER
  // BY would put !a first. The digest is over this list, so it must be fixed.
  assert.deepEqual(body.rooms, ["!C:41chan.net", "!a:41chan.net", "!b:41chan.net"]);
  assert.equal(body.mxid, ALICE);
  assert.equal(body.count, 3);
  assert.equal(body.digest, crypto.createHash("sha256").update("!C:41chan.net\n!a:41chan.net\n!b:41chan.net").digest("hex"));
  assert.equal(body.digest, roomsDigest(body.rooms));
  assert.equal(body.as_of, 1792026850598);
  assert.deepEqual(Object.keys(body).sort(), ["as_of", "count", "digest", "mxid", "rooms"]);
});

test("200 with no rooms: an empty list, count 0, the digest of the empty string", async () => {
  const { g } = gate({ rooms: {} });
  const body = JSON.parse((await g.answer(BOB)).body);
  assert.deepEqual(body.rooms, []);
  assert.equal(body.count, 0);
  assert.equal(body.digest, crypto.createHash("sha256").update("").digest("hex"));
});

test("401: no verified identity -- {error, fix}, no-store, and the database is never asked", async () => {
  const { g, calls } = gate();
  for (const who of [null, undefined, ""]) {
    const r = await g.answer(who);
    assert.equal(r.status, 401);
    assert.equal(r.headers["Cache-Control"], "no-store");
    const body = JSON.parse(r.body);
    assert.deepEqual(Object.keys(body).sort(), ["error", "fix"]);
    assert.match(body.fix, /Sign in/);
  }
  assert.deepEqual(calls, []);
});

test("503: Synapse unreadable -- {error, fix} naming the code only, Retry-After, nothing cached", async () => {
  const cache = fakeCache();
  const { g } = gate({ cache, read: async () => { throw Object.assign(new Error("connect ECONNREFUSED 172.18.0.5:5432"), { code: "ECONNREFUSED" }); } });
  const r = await g.answer(ALICE);
  assert.equal(r.status, 503);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.headers["Retry-After"], "10");
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ["error", "fix"]);
  assert.match(body.error, /ECONNREFUSED/);
  assert.doesNotMatch(r.body, /172\.18/, "no address on the answer");
  assert.equal(cache.sets.length, 0);
});

test("cache: a non-empty set is cached as viewerrooms1:<mxid> for 10 s and served from there", async () => {
  const { g, calls, cache } = gate();
  await g.answer(ALICE);
  assert.equal(CACHE_TTL_S, 10);
  assert.deepEqual(cache.sets.map(([k, , ttl]) => [k, ttl]), [[CACHE_KEY + ALICE, 10]]);
  assert.equal(CACHE_KEY, "viewerrooms1:");
  const again = JSON.parse((await g.answer(ALICE)).body);
  assert.equal(calls.length, 1, "the second ask was the cache's");
  assert.equal(again.count, 3);
});

test("cache: an EMPTY set is never cached -- a viewer who has joined nothing yet is asked again", async () => {
  let rooms = [];
  const { g, cache } = gate({ read: async () => rooms });
  assert.equal(JSON.parse((await g.answer(BOB)).body).count, 0);
  assert.equal(cache.sets.length, 0);
  rooms = ["!new:41chan.net"];
  assert.deepEqual(JSON.parse((await g.answer(BOB)).body).rooms, ["!new:41chan.net"], "the join is seen at once");
});

test("cache: a malformed cached value is a miss, and a cache that throws is a miss, never an outage", async () => {
  const cache = fakeCache();
  cache.store.set(CACHE_KEY + ALICE, { rooms: "not a list" });
  const { g, calls } = gate({ cache });
  assert.equal((await g.answer(ALICE)).status, 200);
  assert.equal(calls.length, 1);
  const broken = gate({ cache: { get: async () => { throw new Error("redis down"); }, set: async () => { throw new Error("redis down"); } } });
  assert.equal((await broken.g.answer(ALICE)).status, 200);
});

test("coalesced: concurrent asks for one viewer share one query", async () => {
  let release;
  const gateOpen = new Promise((r) => { release = r; });
  let n = 0;
  const { g } = gate({ read: async () => { n++; await gateOpen; return ["!r:41chan.net"]; } });
  const all = Promise.all([g.answer(ALICE), g.answer(ALICE), g.answer(ALICE)]);
  release();
  const out = await all;
  assert.equal(n, 1);
  assert.ok(out.every((r) => r.status === 200));
});

// -- through verify.js: the door, bound to the cookie's own MXID -------------

function fakeRes() {
  return {
    _status: null, _headers: {}, _body: undefined,
    set(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    status(c) { this._status = c; return this; },
    end() { return this; },
    send(b) { this._body = b; return this; },
  };
}
async function ask(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test("verify: ?gate=rooms answers for the COOKIE's MXID; nothing in the request can name another user", async () => {
  const { g, calls } = gate({ rooms: { [ALICE]: ["!a:41chan.net"], [BOB]: ["!secret:41chan.net"] } });
  const handler = makeVerifyHandler({
    getSession: async (sid) => (sid === "alice-sid" ? { matrixUserId: ALICE } : null),
    cookieName: "fourier_session",
    gates: { rooms: g },
  });
  const res = await ask(handler, {
    cookies: { fourier_session: "alice-sid" },
    query: { gate: "rooms", mxid: BOB, user: BOB, user_id: BOB },
    headers: { "x-fourier-identity": BOB },
  });
  assert.equal(res._status, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.mxid, ALICE);
  assert.deepEqual(body.rooms, ["!a:41chan.net"]);
  assert.deepEqual(calls, [ALICE]);
});

test("verify: ?gate=rooms with no session is the gate's JSON 401", async () => {
  const { g } = gate();
  const handler = makeVerifyHandler({ getSession: async () => null, cookieName: "fourier_session", gates: { rooms: g } });
  const res = await ask(handler, { cookies: {}, query: { gate: "rooms" } });
  assert.equal(res._status, 401);
  assert.deepEqual(Object.keys(JSON.parse(res._body)).sort(), ["error", "fix"]);
});

test("verify: ?gate=rooms with a session store that throws is a JSON 503 {error, fix}, never an HTML page", async () => {
  const { g, calls } = gate();
  const handler = makeVerifyHandler({
    getSession: async () => { throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" }); },
    cookieName: "fourier_session",
    gates: { rooms: g },
  });
  const orig = console.error; console.error = () => {};
  try {
    const res = await ask(handler, { cookies: { fourier_session: "x" }, query: { gate: "rooms" } });
    assert.equal(res._status, 503);
    assert.equal(res._headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res._headers["cache-control"], "no-store");
    const body = JSON.parse(res._body);
    assert.deepEqual(Object.keys(body).sort(), ["error", "fix"]);
    assert.match(body.error, /session store/);
    assert.deepEqual(calls, []);
  } finally { console.error = orig; }
});
