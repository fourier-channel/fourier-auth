"use strict";

// A VIEWER'S ROOMS: GET /verify?gate=rooms (gate 3 for posts).
//
// fourier-basis docs/design/GATE3_MATRIX_POSTS.md and GATE3_CONTRACTS.md A1:
// a Matrix post is visible to exactly the viewers its image is visible to, so
// the booru must learn which rooms a viewer is joined to. It asks HERE, on the
// existing /verify door (ruling 2026-09-24: no new routes), forwarding only the
// viewer's own fourier_session cookie -- so the answer is always the cookie's
// own MXID's, and nobody can ask about someone else. There is no parameter
// naming a user; verify.js hands this gate the session's identity and nothing
// from the request.
//
//   200 {"mxid","rooms":[sorted],"count","digest","as_of"}   Cache-Control: no-store
//   401 {"error","fix"}   no verified Matrix identity (signed out, or no MXID)
//   503 {"error","fix"}   the session store or Synapse's database unreadable
//
// The booru treats anything but a well-formed 200 as the set {0} -- no Matrix
// posts -- and checks body.mxid against X-Fourier-Identity, so a 503 HIDES and
// never shows (GATE3_MATRIX_POSTS.md rule 6: fail closed, loudly).
//
// digest is sha256 over the rooms joined by "\n", hex: the booru can tell an
// unchanged set without comparing lists. Rooms are sorted HERE, in code-unit
// order, not by the database's ORDER BY: the digest is over the list as sent,
// and it must not change with a collation.
//
// CACHE: viewerrooms1:<mxid> in Redis for 10 s, non-empty only (a viewer who
// has joined nothing yet must not be stuck at nothing), and concurrent asks for
// one viewer share one query. With the booru's own 45 s that bounds how long a
// left room keeps showing its posts at about a minute -- the same bound for a
// leave as for a kick (memory involuntary-matches-voluntary-teardown). Redis is
// an accelerator here, as in mediaauth-core.js: a cache failure is a miss.

const crypto = require("crypto");

const CACHE_KEY = "viewerrooms1:";
const CACHE_TTL_S = 10;

function jsonAnswer(status, obj, extra = {}) {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
    body: JSON.stringify(obj),
  };
}

function roomsDigest(rooms) {
  return crypto.createHash("sha256").update(rooms.join("\n")).digest("hex");
}

// A cached value is used only if it is exactly what this file writes.
function validCached(v) {
  return !!v && typeof v === "object" && Array.isArray(v.rooms) && v.rooms.length > 0 &&
    v.rooms.every((r) => typeof r === "string") && Number.isSafeInteger(v.as_of);
}

function createRoomsGate({ readJoinedRooms, cacheGet, cacheSet, now = () => Date.now(), log = console, ttlSeconds = CACHE_TTL_S }) {
  const inflight = new Map();

  async function roomsOf(mxid) {
    const hit = await cacheGet(CACHE_KEY + mxid).catch(() => null);
    if (validCached(hit)) return hit;
    let p = inflight.get(mxid);
    if (!p) {
      p = (async () => {
        const raw = await readJoinedRooms(mxid);
        if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string")) {
          throw new Error("the joined-rooms query returned something that is not a list of room ids");
        }
        const value = { rooms: [...raw].sort(), as_of: now() };
        if (value.rooms.length > 0) await cacheSet(CACHE_KEY + mxid, value, ttlSeconds).catch(() => {});
        return value;
      })().finally(() => inflight.delete(mxid));
      inflight.set(mxid, p);
    }
    return p;
  }

  // mxid (from the session, never from the request) -> { status, headers, body }. Never throws.
  async function answer(mxid) {
    if (!mxid) {
      return jsonAnswer(401, {
        error: "no verified Matrix identity: the fourier_session cookie is missing, expired, or names no Matrix user",
        fix: "Sign in at https://booru.41chan.net or in Technetium; until then this viewer sees no Matrix posts.",
      });
    }
    let value;
    try {
      value = await roomsOf(mxid);
    } catch (err) {
      // The page gets the error's code only; a database error's message can
      // carry an address. The log gets the whole thing.
      log.error(`[rooms-gate] refused (Synapse unreadable) for ${mxid}: ${err.message}`);
      return jsonAnswer(503, {
        error: `Synapse's database could not be read (${err.code || err.name || "unknown"}), so this viewer's rooms are unknown`,
        fix: "Check fourier-auth's /healthz (synapse-schema) and the synapse-postgres container; the booru shows this viewer no Matrix posts until this answers.",
      }, { "Retry-After": "10" });
    }
    return jsonAnswer(200, {
      mxid,
      rooms: value.rooms,
      count: value.rooms.length,
      digest: roomsDigest(value.rooms),
      as_of: value.as_of,
    });
  }

  // verify.js calls this instead of its HTML door page when the session store
  // cannot be read: the booru reads JSON from this gate, never a page.
  function storeUnavailable(err) {
    return jsonAnswer(503, {
      error: `the session store could not be read (${(err && (err.code || err.name)) || "unknown"}), so who this viewer is is unknown`,
      fix: "Check fourier-auth's /healthz (session store) and the fourier-redis container; the booru shows this viewer no Matrix posts until this answers.",
    }, { "Retry-After": "30" });
  }

  return { answer, storeUnavailable };
}

module.exports = { createRoomsGate, roomsDigest, CACHE_KEY, CACHE_TTL_S };
