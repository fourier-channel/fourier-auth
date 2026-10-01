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

// These lifetimes bound how long an ALLOW can outlive the facts behind it.
// They never make a denial: a no from the cache is re-asked of the source
// before it is given (see checkMediaAccess), because every one of these lists
// GROWS -- a user joins rooms, an image is posted again elsewhere, a room turns
// encryption on -- and a list read before it grew says no to things that are
// now yes.
const TTL = {
  // An mxc does not change what it IS; long.
  siteAsset: 6 * 60 * 60,
  // The rooms containing an mxc only grow (a repost, a forward); long.
  mediaRooms: 6 * 60 * 60,
  // Membership changes; this is the security-sensitive window where a
  // just-removed user could still fetch. Short.
  joinedRooms: 5 * 60,
  encrypted: 6 * 60 * 60,
  // Who uploaded a media id never changes.
  uploader: 24 * 60 * 60,
  // A user who has ever joined a room stays someone who has; only a yes is
  // cached, since a no can become a yes.
  uploaderJoined: 6 * 60 * 60,
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
 *   queryUploader(server, mediaId) -> string|null  (the local uploader's
 *                              MXID; null = remote media or no record)
 *   queryIsSiteAsset(mxc, uploader, server) -> boolean
 *   queryMediaRooms(mxc, uploader) -> string[]   (empty = not seen anywhere)
 *   queryIsEncrypted(roomId)-> boolean
 *   queryUploaderJoined(roomId, uploader) -> boolean (ever joined that room)
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

  // Booleans are wrapped as {v} (a bare false is indistinguishable from a
  // miss); room lists are stored raw and only when non-empty (an empty list
  // for a not-yet-synced image must not stick).
  //
  // The site-asset and media-room keys carry a "2" since the uploader rule
  // (leak audit F-G3, 2026-10-01): the old keys hold answers computed WITHOUT
  // it, for six hours, and reading them would keep the hole open for that long
  // after the deploy that closes it.
  const getUploader = (serverName, mediaId) =>
    cached(`uploader:mxc://${serverName}/${mediaId}`, ttl.uploader,
      async () => ({ v: await deps.queryUploader(serverName, mediaId) }))
      .then((r) => r.v);
  const isSiteAsset = (mxc, uploader, serverName) =>
    cached("siteasset2:" + mxc, ttl.siteAsset, async () => ({ v: await deps.queryIsSiteAsset(mxc, uploader, serverName) }))
      .then((r) => r.v);
  const resolveMediaRooms = (mxc, uploader) =>
    cached("mediarooms2:" + mxc, ttl.mediaRooms, () => deps.queryMediaRooms(mxc, uploader), (rooms) => rooms.length > 0);
  const uploaderJoined = (roomId, uploader) =>
    !uploader ? Promise.resolve(false)
      : cached(`uploaderin:${roomId}:${uploader}`, ttl.uploaderJoined,
          async () => ({ v: await deps.queryUploaderJoined(roomId, uploader) }), (r) => r.v === true)
          .then((r) => r.v);
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
   * names the room it is viewing and we check membership of THAT room.
   * Honoured only for rooms that are actually encrypted (in a cleartext room an
   * unresolvable mxc is media that was never posted), AND only when the
   * media's UPLOADER has been a member of the room named (leak audit F-G4,
   * 2026-10-01). Before that, "knowing the mxc is evidence of having decrypted
   * the event" was the whole argument, and it let a member of ANY encrypted
   * room read any unplaced mxc -- a redacted image, a DM attachment -- by
   * naming their own room. The uploader rule ties the hint to the room the
   * image could actually have been posted in.
   *
   * WHO PUT IT THERE (F-G3). A reference to an mxc counts -- as a site asset,
   * or as placing it in a room -- only when its sender is the media's
   * uploader. Without that, a member who learned the mxc of a DM image could
   * set it as their own avatar (site asset: readable by everyone signed in),
   * or as their member avatar or a room avatar in a room of their own, and
   * read it. A MESSAGE by someone else still counts when its sender has been
   * in a room where the uploader posted it -- that is a forward, which Element
   * does by reference. Media with no local uploader record (remote, or older
   * than the record) keeps the old rule: there is no uploader to compare.
   *
   * Returns true/false for a decision. THROWS MediaAuthUnavailable when the
   * decision could not be made. Never confuses the two.
   */
  // The content rule, given the facts. isEncrypted is asked only when the
  // encrypted-room hint is the last way in.
  async function decideContent(mediaRooms, joinedRooms, roomId, isEncrypted, uploaderIn) {
    if (joinedRooms.length === 0) return false;
    const joined = new Set(joinedRooms);
    if (mediaRooms.length > 0) return mediaRooms.some((r) => joined.has(r));
    if (!roomId || !joined.has(roomId)) return false;
    if (!(await isEncrypted(roomId))) return false;
    return await uploaderIn(roomId);
  }

  // The same facts read from the source, bypassing the cache, and written back
  // so the next ask sees them too. Coalesced like everything else: a wall of
  // thumbnails denied together re-asks once.
  const freshMediaRooms = (mxc, uploader) =>
    coalesce("fresh:mediarooms:" + mxc, async () => {
      const rooms = await deps.queryMediaRooms(mxc, uploader);
      if (rooms.length > 0) await deps.cacheSet("mediarooms2:" + mxc, rooms, ttl.mediaRooms).catch(() => {});
      return rooms;
    });
  const freshUploaderJoined = (roomId, uploader) =>
    !uploader ? Promise.resolve(false)
      : coalesce(`fresh:uploaderin:${roomId}:${uploader}`, async () => {
          const v = await deps.queryUploaderJoined(roomId, uploader);
          if (v) await deps.cacheSet(`uploaderin:${roomId}:${uploader}`, { v }, ttl.uploaderJoined).catch(() => {});
          return v;
        });
  const freshJoinedRooms = (token) => {
    const h = deps.hashToken(token);
    return coalesce("fresh:userrooms:" + h, async () => {
      const rooms = await deps.fetchJoinedRooms(token);
      if (rooms.length > 0) await deps.cacheSet("userrooms:" + h, rooms, ttl.joinedRooms).catch(() => {});
      return rooms;
    });
  };
  const freshIsEncrypted = (roomId) =>
    coalesce("fresh:encrypted:" + roomId, async () => {
      const v = await deps.queryIsEncrypted(roomId);
      await deps.cacheSet("encrypted:" + roomId, { v }, ttl.encrypted).catch(() => {});
      return v;
    });

  // WHY a refusal was a refusal, from the same facts the decision used. The
  // lamp needs this (gateSignals.js): before it, every refusal to a signed-in
  // reader turned the gate red, because the incident the lamp was built for --
  // tokens that had died, 2026-09-19 -- looked identical to a correct no. On
  // 2026-09-28 it went red over and over for an image its poster had deleted
  // in June; the gate was right every time.
  //
  //   no-rooms       the token sees no room at all: a dead token (the
  //                  incident) or an account that has joined nothing yet.
  //   not-member     the image is in rooms, this reader is in none of them,
  //                  and did not name one they are in. The gate working.
  //   unplaced       the image is in no room this server can see: deleted,
  //                  never posted, or in an encrypted room the client did not
  //                  name (Element never names one).
  function refusalReason(mediaRooms, joinedRooms, roomId) {
    if (joinedRooms.length === 0) return "no-rooms";
    if (mediaRooms.length > 0) return "not-member";
    if (roomId && !joinedRooms.includes(roomId)) return "not-member";
    return "unplaced";
  }

  async function checkMediaAccess(token, serverName, mediaId, opts2 = {}) {
    return (await decideMediaAccess(token, serverName, mediaId, opts2)).allowed;
  }

  // checkMediaAccess with its reason. {allowed: true}, or {allowed: false,
  // reason} with reason one of: token-rejected (a site asset asked for with a
  // token Synapse does not recognise), no-rooms, not-member, unplaced.
  async function decideMediaAccess(token, serverName, mediaId, opts2 = {}) {
    const mxc = `mxc://${serverName}/${mediaId}`;
    try {
      const uploader = await getUploader(serverName, mediaId);
      if (await isSiteAsset(mxc, uploader, serverName)) {
        return (await deps.whoamiOk(token)) ? { allowed: true } : { allowed: false, reason: "token-rejected" };
      }
      const [mediaRooms, joinedRooms] = await Promise.all([
        resolveMediaRooms(mxc, uploader),
        getJoinedRooms(token),
      ]);
      const cachedIn = (roomId) => uploaderJoined(roomId, uploader);
      if (await decideContent(mediaRooms, joinedRooms, opts2.roomId, isEncryptedRoom, cachedIn)) return { allowed: true };
      // A NO FROM THE CACHE IS NOT A NO. Every cached list here only grows, so
      // a stale one can only wrongly refuse. Reported 2026-09-25 as a new
      // account whose images partly never loaded, and traced here: a new
      // account joins rooms in its first minutes, and the joined-rooms list
      // cached at its first image refused every image in the rooms it joined
      // after that for five minutes -- Technetium's retries are spent in about
      // twelve seconds, so the picture stayed "unavailable" -- and an image
      // posted again in a second room was refused there for six hours to anyone
      // not also in the first. Only a refusal pays for the re-ask; an allow is
      // unchanged, including the short window a just-removed member keeps.
      const [freshMedia, freshJoined] = await Promise.all([
        freshMediaRooms(mxc, uploader),
        freshJoinedRooms(token),
      ]);
      const freshIn = (roomId) => freshUploaderJoined(roomId, uploader);
      if (await decideContent(freshMedia, freshJoined, opts2.roomId, freshIsEncrypted, freshIn)) return { allowed: true };
      return { allowed: false, reason: refusalReason(freshMedia, freshJoined, opts2.roomId) };
    } catch (err) {
      throw new MediaAuthUnavailable(err);
    }
  }

  return {
    checkMediaAccess,
    decideMediaAccess,
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

// The tables db/synapse-grants.sql grants SELECT on, read from its GRANT
// lines only -- the same reason declaredIndexNames reads CREATE lines only.
function declaredGrantTables(sqlText) {
  const out = [];
  const re = /^GRANT SELECT ON ([a-z_][a-z0-9_]*) TO /gm;
  let m;
  while ((m = re.exec(sqlText)) !== null) out.push(m[1]);
  return out;
}

module.exports = { createMediaAuth, MediaAuthUnavailable, TTL, declaredIndexNames, declaredGrantTables };
