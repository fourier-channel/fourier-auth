// Per-room media authorization for the /media gate.
//
// Model (see fourier-basis devlog, 2026-06-28): a user may fetch a piece of
// media iff they are joined to >=1 Matrix room that contains it. Synapse's
// authenticated-media endpoint authenticates the *token* but does NOT enforce
// per-room membership (a deliberate spec scoping decision, MSC3916) -- so any
// valid token could fetch any mxc. This module adds the missing room-scoped
// check, uniformly for both the Bearer (client) and cookie (booru) paths.
//
// Two halves:
//   resolveMediaRooms(mxc)  -> which rooms contain this mxc. Read directly from
//     Synapse's Postgres (events x event_json on content.url), because Matrix
//     exposes NO media->room lookup in the client API. Uses a dedicated
//     read-only role (fourier_auth_ro). COUPLING NOTE: this depends on Synapse's
//     DB schema (events/event_json, json::jsonb #>> '{content,url}'). If a
//     Synapse upgrade changes that shape, this query breaks LOUDLY (resolver
//     errors -> fail-closed -> media stops, very visible) rather than silently.
//     Accepted deliberately; swap for a built index later if it ever bites.
//   getJoinedRooms(token)   -> the rooms the token's owner is joined to, via the
//     user's OWN token (GET /joined_rooms). No admin, no user_id needed -- the
//     endpoint is token-scoped, so the token alone determines the set.
//
// Allow iff the intersection is non-empty. Fail CLOSED on any error or empty
// resolution: if we can't prove access, we deny.

const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");
const { cacheGetJson, cacheSetJson } = require("./session");

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";

// TTLs: an mxc's room set is effectively immutable once posted, so cache it
// long. Membership changes (join/leave), so cache it briefly -- this is the
// security-sensitive window where a just-removed user could still fetch.
const MEDIA_ROOMS_TTL = 6 * 60 * 60; // 6h
const JOINED_ROOMS_TTL = 5 * 60;     // 5m

const pool = new Pool({
  host: process.env.SYNAPSE_DB_HOST,
  port: parseInt(process.env.SYNAPSE_DB_PORT || "5432", 10),
  database: process.env.SYNAPSE_DB_NAME,
  user: process.env.SYNAPSE_DB_USER,
  password: process.env.SYNAPSE_DB_PASSWORD,
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => {
  console.error("[mediaauth] pg pool error:", err.code || err.message);
});

// Which rooms contain an m.image message whose content.url is this mxc.
// Cached by mxc (long). Throws on DB error -> caller fails closed.
async function resolveMediaRooms(mxc) {
  const cacheKey = "mediarooms:" + mxc;
  const cached = await cacheGetJson(cacheKey).catch(() => null);
  if (cached) return cached;
  // Every place an mxc can legitimately appear, not just message bodies.
  //
  // This asked only about m.room.message + content.url, which silently missed
  // AVATARS -- they live in m.room.member (content.avatar_url) and
  // m.room.avatar (content.url). An avatar therefore resolved to no rooms,
  // fail-closed denied it, and the gate 403'd every profile picture on the
  // server. It went unnoticed because Synapse served them anyway on its own
  // authenticated endpoint; the moment that fall-through was closed, every
  // avatar in every client broke at once.
  //
  // Also covered: m.sticker, and thumbnail_url inside a message's info block --
  // a thumbnail is a different mxc from its original and was equally invisible.
  const { rows } = await pool.query(
    `select distinct e.room_id
       from events e
       join event_json ej on e.event_id = ej.event_id
      where (e.type in ('m.room.message', 'm.sticker')
              and (ej.json::jsonb #>> '{content,url}' = $1
                or ej.json::jsonb #>> '{content,info,thumbnail_url}' = $1))
         or (e.type = 'm.room.avatar' and ej.json::jsonb #>> '{content,url}' = $1)
         or (e.type = 'm.room.member' and ej.json::jsonb #>> '{content,avatar_url}' = $1)`,
    [mxc]
  );
  const roomIds = rows.map((r) => r.room_id);
  // Cache even an empty result briefly is risky (a not-yet-synced image would
  // stay denied) -- so only cache non-empty resolutions.
  if (roomIds.length > 0) {
    await cacheSetJson(cacheKey, roomIds, MEDIA_ROOMS_TTL).catch(() => {});
  }
  return roomIds;
}

// Rooms the token's owner is joined to. Token-scoped; no user_id needed.
// Cached by a hash of the token (short). Throws on error -> caller fails closed.
async function getJoinedRooms(token) {
  const cacheKey =
    "userrooms:" + crypto.createHash("sha256").update(token).digest("hex");
  const cached = await cacheGetJson(cacheKey).catch(() => null);
  if (cached) return cached;
  const resp = await axios.get(
    `${SYNAPSE_URL}/_matrix/client/v3/joined_rooms`,
    { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
  );
  if (resp.status !== 200 || !resp.data || !Array.isArray(resp.data.joined_rooms)) {
    // Bad/expired token or unexpected shape -> treat as no access (fail closed).
    return [];
  }
  const joined = resp.data.joined_rooms;
  await cacheSetJson(cacheKey, joined, JOINED_ROOMS_TTL).catch(() => {});
  return joined;
}

// The gate. true = allow, false = deny. Fail closed on ANY error.
async function checkMediaAccess(token, serverName, mediaId) {
  const mxc = `mxc://${serverName}/${mediaId}`;
  try {
    const [mediaRooms, joinedRooms] = await Promise.all([
      resolveMediaRooms(mxc),
      getJoinedRooms(token),
    ]);
    if (mediaRooms.length === 0 || joinedRooms.length === 0) return false;
    const joinedSet = new Set(joinedRooms);
    return mediaRooms.some((r) => joinedSet.has(r));
  } catch (err) {
    console.error("[mediaauth] check failed (fail-closed):", err.code || err.message);
    return false;
  }
}

module.exports = { checkMediaAccess, resolveMediaRooms, getJoinedRooms };
