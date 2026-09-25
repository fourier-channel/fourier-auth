"use strict";

// Proves the two properties the 2026-09-05 media-auth incident demanded, with
// no database: coalescing (a wall of thumbnails is one query), and that "could
// not check" is never rendered as "no".

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMediaAuth, MediaAuthUnavailable } = require("./mediaauth-core");

function fakes(overrides = {}) {
  const calls = { siteAsset: 0, mediaRooms: 0, joined: 0, whoami: 0, encrypted: 0 };
  const cache = new Map();
  const deps = {
    queryIsSiteAsset: async () => { calls.siteAsset++; return false; },
    queryMediaRooms: async () => { calls.mediaRooms++; return ["!room:x"]; },
    queryIsEncrypted: async () => { calls.encrypted++; return false; },
    whoamiOk: async () => { calls.whoami++; return true; },
    fetchJoinedRooms: async () => { calls.joined++; return ["!room:x"]; },
    cacheGet: async (k) => (cache.has(k) ? cache.get(k) : null),
    cacheSet: async (k, v) => { cache.set(k, v); },
    hashToken: (t) => "h:" + t,
    ...overrides,
  };
  return { deps, calls, cache };
}

test("twenty concurrent asks about one image cost one query each", async () => {
  const { deps, calls } = fakes();
  const auth = createMediaAuth(deps);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => auth.checkMediaAccess("tok", "41chan.net", "abc"))
  );
  assert.ok(results.every((r) => r === true));
  assert.equal(calls.siteAsset, 1, "site-asset classification ran once, not twenty times");
  assert.equal(calls.mediaRooms, 1, "room resolution ran once");
  assert.equal(calls.joined, 1, "joined-rooms fetched once per token");
  assert.equal(auth.inflightCount(), 0, "nothing left in flight");
});

test("a cached answer costs no query at all", async () => {
  const { deps, calls } = fakes();
  const auth = createMediaAuth(deps);
  await auth.checkMediaAccess("tok", "41chan.net", "abc");
  await auth.checkMediaAccess("tok", "41chan.net", "abc");
  assert.equal(calls.siteAsset, 1);
  assert.equal(calls.mediaRooms, 1);
});

test("a database outage is MediaAuthUnavailable, never a denial", async () => {
  const boom = Object.assign(new Error("timeout exceeded when trying to connect"), { code: "ETIMEDOUT" });
  const { deps } = fakes({ queryIsSiteAsset: async () => { throw boom; } });
  const auth = createMediaAuth(deps);
  await assert.rejects(
    () => auth.checkMediaAccess("tok", "41chan.net", "abc"),
    (err) => err instanceof MediaAuthUnavailable && err.cause === boom,
  );
});

test("Synapse unreachable during whoami is unavailable, not 'token invalid'", async () => {
  const { deps } = fakes({
    queryIsSiteAsset: async () => true,
    whoamiOk: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
  });
  const auth = createMediaAuth(deps);
  await assert.rejects(() => auth.checkMediaAccess("tok", "41chan.net", "av"), MediaAuthUnavailable);
});

test("a real 'no' is false and does not throw", async () => {
  const notOurs = createMediaAuth(fakes({ queryIsSiteAsset: async () => true, whoamiOk: async () => false }).deps);
  assert.equal(await notOurs.checkMediaAccess("tok", "41chan.net", "av"), false);
  const notInRoom = createMediaAuth(fakes({ fetchJoinedRooms: async () => ["!other:x"] }).deps);
  assert.equal(await notInRoom.checkMediaAccess("tok", "41chan.net", "abc"), false);
  const noRooms = createMediaAuth(fakes({ fetchJoinedRooms: async () => [] }).deps);
  assert.equal(await noRooms.checkMediaAccess("tok", "41chan.net", "abc"), false);
});

test("encrypted-room hint: honoured only for a joined room that is encrypted", async () => {
  const base = { queryMediaRooms: async () => [], fetchJoinedRooms: async () => ["!enc:x"] };
  const enc = createMediaAuth(fakes({ ...base, queryIsEncrypted: async () => true }).deps);
  assert.equal(await enc.checkMediaAccess("tok", "41chan.net", "m", { roomId: "!enc:x" }), true);
  const clear = createMediaAuth(fakes({ ...base, queryIsEncrypted: async () => false }).deps);
  assert.equal(await clear.checkMediaAccess("tok", "41chan.net", "m", { roomId: "!enc:x" }), false);
  const notJoined = createMediaAuth(fakes({ ...base, queryIsEncrypted: async () => true }).deps);
  assert.equal(await notJoined.checkMediaAccess("tok", "41chan.net", "m", { roomId: "!else:x" }), false);
  const noHint = createMediaAuth(fakes({ ...base, queryIsEncrypted: async () => true }).deps);
  assert.equal(await noHint.checkMediaAccess("tok", "41chan.net", "m"), false);
});

test("empty room lists are not cached; site-asset booleans are cached wrapped", async () => {
  const { deps, cache } = fakes({ queryMediaRooms: async () => [], fetchJoinedRooms: async () => ["!r:x"] });
  const auth = createMediaAuth(deps);
  await auth.checkMediaAccess("tok", "41chan.net", "m");
  assert.equal(cache.has("mediarooms:mxc://41chan.net/m"), false, "an empty resolution must not stick");
  assert.deepEqual(cache.get("siteasset:mxc://41chan.net/m"), { v: false });
});

// A cached list only grows stale in one direction -- it misses rooms -- so a
// refusal read from the cache is re-asked of the source. Reported 2026-09-25:
// a new account's images partly never loaded.

test("a room joined after the joined-rooms list was cached is not refused", async () => {
  let joined = ["!a:x"];
  const { deps, calls } = fakes({
    queryMediaRooms: async (mxc) => { calls.mediaRooms++; return mxc.endsWith("/inA") ? ["!a:x"] : ["!b:x"]; },
    fetchJoinedRooms: async () => { calls.joined++; return joined; },
  });
  const auth = createMediaAuth(deps);
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "inA"), true, "caches the list [!a]");
  joined = ["!a:x", "!b:x"]; // the new account joins its second room
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "inB"), true, "an image in the room just joined loads");
  assert.deepEqual(await deps.cacheGet("userrooms:h:tok"), ["!a:x", "!b:x"], "and the fresh list replaced the stale one");
});

test("an image posted again in a second room is not refused there", async () => {
  let rooms = ["!a:x"];
  const { deps } = fakes({
    queryMediaRooms: async () => rooms,
    fetchJoinedRooms: async (tok) => (tok === "old" ? ["!a:x"] : ["!b:x"]),
  });
  const auth = createMediaAuth(deps);
  assert.equal(await auth.checkMediaAccess("old", "41chan.net", "pic"), true, "caches the image's rooms as [!a]");
  rooms = ["!a:x", "!b:x"]; // reposted into !b
  assert.equal(await auth.checkMediaAccess("new", "41chan.net", "pic"), true, "a reader only in !b sees it");
});

test("a room that turned encryption on after it was cached as clear is not refused", async () => {
  let encrypted = false;
  const { deps } = fakes({
    queryMediaRooms: async () => [],
    fetchJoinedRooms: async () => ["!dm:x"],
    queryIsEncrypted: async () => encrypted,
  });
  const auth = createMediaAuth(deps);
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "m1", { roomId: "!dm:x" }), false);
  encrypted = true;
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "m2", { roomId: "!dm:x" }), true);
});

test("a real refusal is still a refusal, and re-asks the source once however many ask", async () => {
  const { deps, calls } = fakes({ fetchJoinedRooms: async () => { calls.joined++; return ["!other:x"]; } });
  const auth = createMediaAuth(deps);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => auth.checkMediaAccess("tok", "41chan.net", "abc"))
  );
  assert.ok(results.every((r) => r === false), "not in the room is still no");
  assert.equal(calls.joined, 2, "one cached read and one fresh re-ask, not twenty");
  assert.equal(calls.mediaRooms, 2, "likewise for the image's rooms");
});

test("an allow never pays for a re-ask, so a just-removed member's window is unchanged", async () => {
  let joined = ["!room:x"];
  const { deps, calls } = fakes({ fetchJoinedRooms: async () => { calls.joined++; return joined; } });
  const auth = createMediaAuth(deps);
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "abc"), true);
  joined = []; // removed from the room
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "abc"), true, "the cached allow stands for its TTL, as before");
  assert.equal(calls.joined, 1, "and nothing was re-asked on the way");
});

test("Redis failing is a cache miss, not an outage", async () => {
  const { deps, calls } = fakes({
    cacheGet: async () => { throw new Error("redis down"); },
    cacheSet: async () => { throw new Error("redis down"); },
  });
  const auth = createMediaAuth(deps);
  assert.equal(await auth.checkMediaAccess("tok", "41chan.net", "abc"), true);
  assert.equal(calls.mediaRooms, 1);
});

test("declaredIndexNames reads CREATE lines only, never comments", () => {
  const { declaredIndexNames } = require("./mediaauth-core");
  const sql = [
    "-- Idempotent: IF NOT EXISTS makes re-running a no-op.",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS event_json_content_url_idx",
    "  ON event_json ((json::jsonb #>> '{content,url}'));",
    "CREATE INDEX IF NOT EXISTS events_site_asset_types_idx ON events (type) WHERE type = 'x';",
    "ANALYZE event_json;",
  ].join("\n");
  assert.deepEqual(declaredIndexNames(sql), ["event_json_content_url_idx", "events_site_asset_types_idx"]);
});

test("the tracked SQL declares the four indexes the gate relies on", () => {
  const { declaredIndexNames } = require("./mediaauth-core");
  const fs = require("node:fs");
  const names = declaredIndexNames(fs.readFileSync(require.resolve("./db/synapse-indexes.sql"), "utf8"));
  for (const n of ["event_json_content_url_idx", "event_json_content_avatar_url_idx", "event_json_content_thumbnail_url_idx", "events_site_asset_types_idx"]) {
    assert.ok(names.includes(n), n);
  }
});
