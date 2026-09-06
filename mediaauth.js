// Per-room media authorization for the /media gate -- the I/O half.
//
// Model (see fourier-basis devlog, 2026-06-28): a user may fetch a piece of
// media iff they are joined to >=1 Matrix room that contains it. Synapse's
// authenticated-media endpoint authenticates the *token* but does NOT enforce
// per-room membership (a deliberate spec scoping decision, MSC3916) -- so any
// valid token could fetch any mxc. This adds the missing room-scoped check,
// uniformly for both the Bearer (client) and cookie (booru) paths.
//
// The DECISION lives in mediaauth-core.js and is tested there with fakes. This
// file supplies the real dependencies: Synapse's Postgres (read-only role),
// Redis, and Synapse's client API. Every dependency THROWS when it cannot find
// out and RETURNS a value when the answer is "no" -- the core relies on that
// contract to tell an outage from a denial.
//
// COUPLING NOTE: the queries read Synapse's own schema (events, event_json,
// json::jsonb #>> '{content,url}'), because Matrix exposes NO media->room
// lookup in the client API. If a Synapse upgrade changes that shape, this
// breaks LOUDLY (503s, very visible) rather than silently. Accepted.
//
// The expressions in these queries are indexed by db/synapse-indexes.sql.
// Without those indexes each is a sequential scan of event_json -- 1.4 s and
// 1.8 s per cold image, measured 2026-09-05 -- and the pool below drains into
// its five-second deadline. tools/ensure-synapse-indexes.sh applies and
// verifies them at deploy; they are not Synapse's and Synapse will not
// recreate them.

const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");
const { cacheGetJson, cacheSetJson } = require("./session");
const { createMediaAuth, MediaAuthUnavailable } = require("./mediaauth-core");

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";

const pool = new Pool({
  host: process.env.SYNAPSE_DB_HOST,
  port: parseInt(process.env.SYNAPSE_DB_PORT || "5432", 10),
  database: process.env.SYNAPSE_DB_NAME,
  user: process.env.SYNAPSE_DB_USER,
  password: process.env.SYNAPSE_DB_PASSWORD,
  // Was 4. With the indexes a lookup is tens of milliseconds, so sixteen
  // connections is hundreds of decisions a second; without them no pool size
  // saves a 1.4 s scan, which is why the number alone was never the fix.
  max: parseInt(process.env.SYNAPSE_DB_POOL_MAX || "16", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => {
  console.error("[mediaauth] pg pool error:", err.code || err.message);
});

// Site asset: an avatar (profile or member event), a room icon, or an image in
// an emoji pack (im.ponies.* / m.image_pack -- a reaction image is chrome too).
async function queryIsSiteAsset(mxc) {
  const { rows } = await pool.query(
    `select 1 where exists (select 1 from profiles where avatar_url = $1)
        or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                    where e.type = 'm.room.member'
                      and ej.json::jsonb #>> '{content,avatar_url}' = $1)
        or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                    where e.type = 'm.room.avatar'
                      and ej.json::jsonb #>> '{content,url}' = $1)
        or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id,
                        lateral jsonb_each(coalesce(ej.json::jsonb #> '{content,images}', '{}'::jsonb)) img
                    where e.type in ('im.ponies.room_emotes', 'im.ponies.user_emotes', 'm.image_pack')
                      and img.value ->> 'url' = $1)
      limit 1`,
    [mxc]
  );
  return rows.length > 0;
}

// Every place an mxc can legitimately appear: message bodies and stickers
// (content.url and the thumbnail_url inside info -- a thumbnail is a different
// mxc from its original), room avatars, and member avatars. Missing the avatar
// forms is what once 403'd every profile picture the moment Synapse's own
// fall-through was closed.
async function queryMediaRooms(mxc) {
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
  return rows.map((r) => r.room_id);
}

async function queryIsEncrypted(roomId) {
  const { rows } = await pool.query(
    `select 1 from current_state_events
      where room_id = $1 and type = 'm.room.encryption' and state_key = '' limit 1`,
    [roomId]
  );
  return rows.length > 0;
}

// Is this token valid on THIS server? The only question a site asset asks.
// A transport failure throws (Synapse unreachable is not "token invalid");
// any non-200 is a plain "no".
async function whoamiOk(token) {
  const r = await axios.get(`${SYNAPSE_URL}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
    timeout: 5000,
  });
  return r.status === 200 && typeof r.data?.user_id === "string";
}

// Rooms the token's owner is joined to, via the user's OWN token: the
// endpoint is token-scoped, so no admin and no user_id are needed. A bad or
// expired token is an empty list (denial); a transport failure throws.
async function fetchJoinedRooms(token) {
  const resp = await axios.get(`${SYNAPSE_URL}/_matrix/client/v3/joined_rooms`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
    timeout: 5000,
  });
  if (resp.status !== 200 || !resp.data || !Array.isArray(resp.data.joined_rooms)) return [];
  return resp.data.joined_rooms;
}

const core = createMediaAuth({
  queryIsSiteAsset,
  queryMediaRooms,
  queryIsEncrypted,
  whoamiOk,
  fetchJoinedRooms,
  cacheGet: cacheGetJson,
  cacheSet: cacheSetJson,
  hashToken: (token) => crypto.createHash("sha256").update(token).digest("hex"),
});

module.exports = {
  checkMediaAccess: core.checkMediaAccess,
  isSiteAsset: core.isSiteAsset,
  resolveMediaRooms: core.resolveMediaRooms,
  getJoinedRooms: core.getJoinedRooms,
  isEncryptedRoom: core.isEncryptedRoom,
  tokenIsOurs: whoamiOk,
  MediaAuthUnavailable,
};
