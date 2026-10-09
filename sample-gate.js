"use strict";

// THE SAMPLING CONSOLE'S DOOR: GET /verify?gate=sample.
//
// Operator ruling 2026-10-09: the sampling surface moves to its own host,
// sample.41chan.net, and "access will be granted explicitly by checking user
// level in the modsmodsmods channel... let's say 70 is needed for sampling
// access." Not the booru's level -- the booru's session cookie is host-only and
// never reaches that host; fourier_session (Domain .41chan.net) does, and it
// names a Matrix user, so the question is asked of Matrix.
//
// The room and the threshold are CONFIG (SAMPLE_GATE_ROOM, SAMPLE_GATE_LEVEL),
// because the ruling names them as choices that will move. Missing or
// malformed config, and a Synapse database that cannot be read, fail CLOSED
// with a 503 whose body names its remedy; a viewer who does not qualify gets a
// 403 naming the room, the level and who can raise it. A pass is 204 with
// X-Fourier-View: internal and X-Fourier-Identity, which the proxy copies onto
// the request it forwards to sampling (forward_auth copy_headers).
//
// It is on the EXISTING /verify route (ruling 2026-09-24: no new routes) as a
// query parameter, and verify.js refuses any gate name it does not know, so a
// typo in the proxy can never fall through to /verify's always-204 answer.
//
// THE RULE, in Matrix's own terms (client-server spec, m.room.power_levels):
// the viewer's level is users[mxid] if present, else users_default, else 0,
// read from the room's CURRENT state. The viewer must ALSO be joined now. A
// power-levels entry outlives membership -- Synapse does not remove it on a
// leave, kick or ban, and the room on 2026-10-09 already holds one for a user
// who left -- so without the join check a moderator removed from the room
// would keep the console. Leaving the room is how access is taken away
// (involuntary-matches-voluntary-teardown: a kick or ban ends it the same way
// a leave does), and a deactivated account leaves every room, so it is caught
// here too. Invited-but-not-joined does not pass.

// The room's state is cached in process for STATE_TTL_MS. The gate is asked
// on every console request -- page loads, the SSE stream's connect, every
// poll -- so uncached it is one Synapse query per request. 15 s bounds that at
// four queries a minute per room whatever the traffic, and bounds how long a
// demotion, kick or ban takes to shut the door at 15 s. Errors are never
// cached (the next request asks again); concurrent misses share one query.
const STATE_TTL_MS = 15_000;

// Every refusal is verify.js's doorPage: HTML, escaped, with the one
// same-frame link back to the booru (review repair 2026-10-09).
const { doorPage } = require("./verify");

// A Matrix room id: !opaque:server. Anything else is a typo, not a room.
const ROOM_ID_RE = /^![^\s:]+:[^\s]+$/;
const INT_RE = /^-?\d+$/;

// "Could not find out", as distinct from "no". Carries the remedy it implies.
class SampleGateUnavailable extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix || "Check fourier-auth's /healthz and its log; nobody is let in until it answers.";
  }
}

// Config, validated once at boot and on every answer. Never throws: a broken
// config is reported (boot log, /healthz) and answered 503, because refusing
// to start would take every Matrix picture down with the console.
function parseSampleGateConfig(env) {
  const room = String(env.SAMPLE_GATE_ROOM || "").trim();
  const levelRaw = String(env.SAMPLE_GATE_LEVEL || "").trim();
  const problems = [];
  if (!room) problems.push("SAMPLE_GATE_ROOM is unset");
  else if (!ROOM_ID_RE.test(room)) problems.push(`SAMPLE_GATE_ROOM "${room}" is not a room id (!opaque:server)`);
  if (!levelRaw) problems.push("SAMPLE_GATE_LEVEL is unset");
  else if (!INT_RE.test(levelRaw)) problems.push(`SAMPLE_GATE_LEVEL "${levelRaw}" is not an integer`);
  if (problems.length) {
    return {
      ok: false,
      problem: `${problems.join("; ")}. Set SAMPLE_GATE_ROOM (the moderators room id) and ` +
        "SAMPLE_GATE_LEVEL (the power level that opens the console) in fourier-auth's " +
        "docker-compose.yaml environment and recreate the container.",
    };
  }
  return { ok: true, room, level: parseInt(levelRaw, 10) };
}

// A power level as the spec allows it: an integer, or (room versions before
// 10) a string of one. Anything else is a malformed event -> null.
function asLevel(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && INT_RE.test(v.trim())) return parseInt(v, 10);
  return null;
}

// users[mxid], else users_default, else 0. Throws on a value the spec would
// not accept: a malformed event is an outage of the answer, not a level 0.
function powerLevelOf(content, mxid) {
  const users = content && typeof content.users === "object" && content.users ? content.users : {};
  const raw = Object.prototype.hasOwnProperty.call(users, mxid) ? users[mxid]
    : content && content.users_default !== undefined ? content.users_default : 0;
  const level = asLevel(raw);
  if (level === null) throw new SampleGateUnavailable(`malformed power level for ${mxid}`);
  return level;
}

// Who can raise a viewer: joined users at or above the level the room needs
// to change m.room.power_levels (events[...], else state_default, else 50).
function whoCanRaise(content, joined) {
  const events = (content && content.events) || {};
  const need = asLevel(events["m.room.power_levels"]) ?? asLevel(content && content.state_default) ?? 50;
  return joined.filter((u) => {
    try { return powerLevelOf(content, u) >= need; } catch (e) { return false; }
  });
}

function createSampleGate({ config, readRoom, ttlMs = STATE_TTL_MS, now = () => Date.now(), log = console }) {
  let cached = null;   // { room, at, state }
  let inflight = null; // { room, promise }

  async function roomState(room) {
    if (cached && cached.room === room && now() - cached.at < ttlMs) return cached.state;
    if (inflight && inflight.room === room) return inflight.promise;
    const promise = (async () => {
      try {
        const state = await readRoom(room);
        if (!state || !state.powerLevels || typeof state.powerLevels !== "object") {
          throw new SampleGateUnavailable(`room ${room} has no power levels on this server`,
            "SAMPLE_GATE_ROOM names a room this server does not hold; correct it in fourier-auth's docker-compose.yaml.");
        }
        cached = { room, at: now(), state };
        return state;
      } finally {
        inflight = null;
      }
    })();
    inflight = { room, promise };
    return promise;
  }

  // mxid -> { status, headers, body? }. Never throws.
  async function answer(mxid) {
    if (!config.ok) {
      log.error(`[sample-gate] refused (not configured): ${config.problem}`);
      return doorPage(503, `Sampling is closed: its access check is not configured. ${config.problem}`);
    }
    if (!mxid) {
      return doorPage(403, "Sampling needs you signed in to 41chan. Sign in at https://booru.41chan.net " +
        "or in Technetium (https://tc.41chan.net), then reload this page.");
    }
    let state;
    let level;
    try {
      state = await roomState(config.room);
      level = powerLevelOf(state.powerLevels, mxid);
    } catch (err) {
      // A database error's message can carry an address; the page gets its
      // code only, the log gets the whole thing.
      const known = err instanceof SampleGateUnavailable;
      const what = known ? err.message : `Synapse database error ${err.code || err.name || "unknown"}`;
      const fix = known ? err.fix : new SampleGateUnavailable("").fix;
      log.error(`[sample-gate] refused (could not read ${config.room}): ${err.message}`);
      return doorPage(503, `Sampling is closed: the access check could not read the moderators room (${what}). ${fix}`,
        { "Retry-After": "30" });
    }
    const joined = state.joined.includes(mxid);
    if (joined && level >= config.level) {
      return { status: 204, headers: { "X-Fourier-View": "internal", "X-Fourier-Identity": mxid, "Cache-Control": "no-store" } };
    }
    const roomName = state.name ? `"${state.name}" (${config.room})` : config.room;
    const admins = whoCanRaise(state.powerLevels, state.joined);
    const ask = admins.length ? admins.join(", ") : "an admin of that room";
    const why = joined
      ? `${mxid} is at power level ${level} there.`
      : `${mxid} is not joined to that room${level > 0 ? ` (a level of ${level} is recorded, but it counts only while joined)` : ""}.`;
    const fix = joined
      ? `Ask ${ask} to raise you to ${config.level}.`
      : `Ask ${ask} for an invite, join, and be given level ${config.level} or above.`;
    // HOW, not just who (review repair 2026-10-09). The operator, the same
    // day: "I don't believe I have 'specific level' setting ability--the
    // current level-change options seemed to just be 'member' 'voice' 'mod'".
    // Technetium (the only client) offers named tiers only on the profile card
    // -- Member 0, Voice 25, Moderator 50, Owner 100 -- and 50 fails this gate
    // while 100 hands over the room for good. The one control in it that
    // enters any level is the bulk panel's free box (technetium
    // src/ui/BulkLevels.tsx, live on tc.41chan.net 2026-10-09), so the refusal
    // walks the raiser there, in that panel's own words. A pending level
    // applies on join there, so the same steps serve the not-joined case.
    const how = "In Technetium the profile card offers only the named levels; use Settings > Server permissions > " +
      `Set a level in many rooms (a server admin's panel): choose the person, type ${config.level} in the box after ` +
      `the named levels, tick ${state.name || config.room}, then Set in 1 and Yes, set it.`;
    return doorPage(403, `Sampling is open to members of the room ${roomName} at power level ${config.level} or above. ${why} ${fix} ${how}`);
  }

  return { answer };
}

module.exports = { createSampleGate, parseSampleGateConfig, powerLevelOf, whoCanRaise, SampleGateUnavailable, STATE_TTL_MS };
