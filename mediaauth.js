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
const { createMediaAuth, MediaAuthUnavailable, declaredIndexNames, declaredGrantTables } = require("./mediaauth-core");
const { makeQueries } = require("./mediaauth-sql");
const fs = require("fs");
const path = require("path");

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";
const HOMESERVER_NAME = process.env.HOMESERVER_NAME || "41chan.net";

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

// The queries live in mediaauth-sql.js, as functions of this pool.
const { queryUploader, queryIsSiteAsset, queryMediaRooms, queryUploaderJoined, queryIsEncrypted } =
  makeQueries(pool, { homeserverName: HOMESERVER_NAME });

// Is this token valid on THIS server? The only question a site asset asks.
// A transport failure throws (Synapse unreachable is not "token invalid");
// any non-200 is a plain "no".
// The same question with the answer kept: the user id Synapse binds this
// token to, or null. Transport failures still throw.
async function whoamiUser(token) {
  const r = await axios.get(`${SYNAPSE_URL}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
    timeout: 5000,
  });
  return r.status === 200 && typeof r.data?.user_id === "string" ? r.data.user_id : null;
}

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
  queryUploader,
  queryIsSiteAsset,
  queryMediaRooms,
  queryIsEncrypted,
  queryUploaderJoined,
  whoamiOk,
  fetchJoinedRooms,
  cacheGet: cacheGetJson,
  cacheSet: cacheSetJson,
  hashToken: (token) => crypto.createHash("sha256").update(token).digest("hex"),
});

// Does the live database have the indexes this service depends on?
//
// Synapse owns that schema and will never create them; a fresh database has
// none of them and every media check silently becomes a sequential scan --
// the 2026-09-05 incident, back without a log line to say so. The read-only
// role cannot create them (tools/ensure-synapse-indexes.sh does, as the DB
// owner, at deploy), but it CAN see whether they exist, so a fresh box says
// at boot what would otherwise show up as 5-second thumbnails. Answers the
// question from pg_index (exists AND valid), never from the file.
async function verifySynapseIndexes() {
  const sql = fs.readFileSync(path.join(__dirname, "db", "synapse-indexes.sql"), "utf8");
  const names = declaredIndexNames(sql);
  const { rows } = await pool.query(
    `select c.relname as name, i.indisvalid as valid
       from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = any($1)`,
    [names]
  );
  const seen = new Map(rows.map((r) => [r.name, r.valid]));
  const missing = names.filter((n) => !seen.has(n));
  const invalid = names.filter((n) => seen.get(n) === false);
  return { ok: missing.length === 0 && invalid.length === 0, declared: names, missing, invalid };
}

// Does this service's own role hold the privileges it queries with? Asked of
// Postgres (has_table_privilege), never of the file. A missing grant is every
// Matrix picture answering 503, so it is said at boot and on /healthz.
async function verifySynapseGrants() {
  const sql = fs.readFileSync(path.join(__dirname, "db", "synapse-grants.sql"), "utf8");
  const tables = declaredGrantTables(sql);
  const { rows } = await pool.query(
    `select t as name, has_table_privilege(current_user, t, 'SELECT') as ok
       from unnest($1::text[]) as t`,
    [tables]
  );
  const missing = rows.filter((r) => !r.ok).map((r) => r.name);
  return { ok: missing.length === 0, declared: tables, missing };
}

module.exports = {
  verifySynapseIndexes,
  verifySynapseGrants,
  checkMediaAccess: core.checkMediaAccess,
  decideMediaAccess: core.decideMediaAccess,
  isSiteAsset: core.isSiteAsset,
  resolveMediaRooms: core.resolveMediaRooms,
  getJoinedRooms: core.getJoinedRooms,
  isEncryptedRoom: core.isEncryptedRoom,
  tokenIsOurs: whoamiOk,
  whoamiUser,
  MediaAuthUnavailable,
};
