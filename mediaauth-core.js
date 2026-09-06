// The media-authorization DECISION, with no I/O of its own.
//
// Everything that touches Postgres, Redis or Synapse is injected, so the
// harness can prove the properties that matter without a database:
//
//   - one in-flight lookup per key, however many requests ask at once
//   - "could not check" is distinct from "no", and is never rendered as "no"
//   - the fail-closed rules themselves, unchanged from before this split
//
// Why this exists (2026-09-05): a timeline of 43 images asked the gate 43
// questions it answered with sequential scans of event_json through a pool of
// four connections and a five-second deadline. Most waited ~5 s; 105 a day
// waited longer and were answered 403 -- "forbidden" -- for images the user was
// entitled to. The indexes (db/synapse-indexes.sql) fixed the scan; this file
// fixes the shape: a wall of thumbnails asking about the same object now costs
// one query, and a gate that cannot reach its database says so instead of
// lying.

const TTL = {
  // An mxc does not change what it IS; long.
  siteAsset: 6 * 60 * 60,
  // The rooms containing an mxc are effectively immutable once posted; long.
  mediaRooms: 6 * 60 * 60,
  // Membership changes; this is the security-sensitive window where a
  // just-removed user could still fetch. Short.
  joinedRooms: 5 * 60,
  encrypted: 6 * 60 * 60,
};

// The gate could not be consulted. Distinct from a denial on purpose: the
// route answers 503 (the edge turns that into an uncached 502 and the client
// retries), where a denial is a final 403. Fail-closed still holds -- nothing
// is served on this path -- but "try again" and "forbidden" are different
// sentences, and 105 users a day were being told the wrong one.
class MediaAuthUnavailable extends Error {
  constructor(cause) {
    const why = (cause && (cause.code || cause.message)) || String(cause);
    super(`media authorization unavailable: ${why}`);
    this.name = "MediaAuthUnavailable";
    this.cause = cause;
  }
}

/**
 * deps -- every one may THROW for "could not find out", and must RETURN a
 * plain value for "no". That contract is what lets the core tell a broken
 * database from a user who is not in the room.
 *
 *   queryIsSiteAsset(mxc)   -> boolean
 *   queryMediaRooms(mxc)    -> string[]   (empty = not seen anywhere)
 *   queryIsEncrypted(roomId)-> boolean
 *   whoamiOk(token)         -> boolean    (false = token not ours)
 *   fetchJoinedRooms(token) -> string[]   (empty = bad token or no rooms)
 *   cacheGet(key)           -> value|null
 *   cacheSet(key, value, ttlSeconds)
 *   hashToken(token)        -> string     (tokens never become cache keys)
 */
function createMediaAuth(deps, opts = {}) {
  const ttl = { ...TTL, ...(opts.ttl || {}) };
  const inflight = new Map();

  // One computation per key at a time. Twenty thumbnails of the same picture
  // mounting at once used to be twenty scans; they are one, and the other
  // nineteen wait for it.
  function coalesce(key, compute) {
    let p = inflight.get(key);
    if (!p) {
      p = compute().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  // Redis is an accelerator, not an authority: a cache failure is a miss, not
  // an outage, so reads and writes here swallow their own errors. The
  // database dependencies do NOT -- see MediaAuthUnavailable.
  async function cached(key, ttlSeconds, compute, shouldCache = () => true) {
    const hit = await deps.cacheGet(key).catch(() => null);
    if (hit !== null && hit !== undefined) return hit;
    return coalesce(key, async () => {
      // Whoever we waited behind may have filled the cache; look again before
      // paying for the query.
      const again = await deps.cacheGet(key).catch(() => null);
      if (again !== null && again !== undefined) return again;
      const value = await compute();
      if (shouldCache(value)) await deps.cacheSet(key, value, ttlSeconds).catch(() => {});
      return value;
    });
  }

  // Cache shapes match what earlier versions wrote, so entries already in Redis
  // stay readable across the deploy: booleans are wrapped as {v} (a bare false
  // is indistinguishable from a miss), room lists are stored raw and only when
  // non-empty (an empty list for a not-yet-synced image must not stick).
  const isSiteAsset = (mxc) =>
    cached("siteasset:" + mxc, ttl.siteAsset, async () => ({ v: await deps.queryIsSiteAsset(mxc) }))
      .then((r) => r.v);
  const resolveMediaRooms = (mxc) =>
    cached("mediarooms:" + mxc, ttl.mediaRooms, () => deps.queryMediaRooms(mxc), (rooms) => rooms.length > 0);
  const getJoinedRooms = (token) =>
    cached("userrooms:" + deps.hashToken(token), ttl.joinedRooms, () => deps.fetchJoinedRooms(token), (rooms) => rooms.length > 0);
  const isEncryptedRoom = (roomId) =>
    cached("encrypted:" + roomId, ttl.encrypted, async () => ({ v: await deps.queryIsEncrypted(roomId) }))
      .then((r) => r.v);

  /**
   * May this token have this mxc? TWO rules, chosen by what the object IS:
   *
   *   SITE ASSET (avatar, room icon, emoji) -> is this user on my server?
   *     Operator ruling 2026-08-15. Asking "which room is this in" of an
   *     avatar is a category error -- it is in none and all of them -- and
   *     asking it is what once 403'd every profile picture on the server.
   *   CONTENT (anything posted in a room) -> are they in a room containing it?
   *
   * ENCRYPTED ROOMS: the mxc lives inside ciphertext, so the server cannot see
   * which room it belongs to and resolveMediaRooms returns nothing. The client
   * names the room it is viewing and we check membership of THAT room -- sound
   * rather than a bypass because knowing the mxc is itself evidence of having
   * decrypted the event. Honoured only for rooms that are actually encrypted:
   * in a cleartext room an unresolvable mxc is media that was never posted.
   *
   * Returns true/false for a decision. THROWS MediaAuthUnavailable when the
   * decision could not be made. Never confuses the two.
   */
  async function checkMediaAccess(token, serverName, mediaId, opts2 = {}) {
    const mxc = `mxc://${serverName}/${mediaId}`;
    try {
      if (await isSiteAsset(mxc)) return await deps.whoamiOk(token);
      const [mediaRooms, joinedRooms] = await Promise.all([
        resolveMediaRooms(mxc),
        getJoinedRooms(token),
      ]);
      if (joinedRooms.length === 0) return false;
      const joined = new Set(joinedRooms);
      if (mediaRooms.length > 0) return mediaRooms.some((r) => joined.has(r));
      const roomId = opts2.roomId;
      if (!roomId || !joined.has(roomId)) return false;
      return await isEncryptedRoom(roomId);
    } catch (err) {
      throw new MediaAuthUnavailable(err);
    }
  }

  return {
    checkMediaAccess,
    isSiteAsset,
    resolveMediaRooms,
    getJoinedRooms,
    isEncryptedRoom,
    // Test seam only.
    inflightCount: () => inflight.size,
  };
}

// The index names db/synapse-indexes.sql declares, read from the CREATE
// statements only. Matching "IF NOT EXISTS <word>" anywhere once found the
// word "makes" inside a comment and reported an index of that name missing.
function declaredIndexNames(sqlText) {
  const names = [];
  const re = /^CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS ([a-z_][a-z0-9_]*)/gm;
  let m;
  while ((m = re.exec(sqlText)) !== null) names.push(m[1]);
  return names;
}

module.exports = { createMediaAuth, MediaAuthUnavailable, TTL, declaredIndexNames };
