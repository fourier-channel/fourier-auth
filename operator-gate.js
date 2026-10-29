"use strict";

// THE OPERATOR'S BOARD DOOR: GET /verify?gate=operator.
//
// Operator ruling 2026-10-25 (fourier-basis OPERATOR_CONTROL_PANEL sec 3, S8):
// the board's queue actions are reached through "fourier-auth sign-in", at
// https://41chan.net/horizon/console/ (moved there 2026-10-29; /horizon/ is the
// public roadmap). A tailnet-device check cannot work there: every
// node on the tailnet is tagged, so none is the operator's. fourier_session
// (Domain .41chan.net) reaches the apex, and it names a Matrix user, so the
// question is "is this one of the listed accounts".
//
// The list is CONFIG (OPERATOR_GATE_MXIDS, comma-separated Matrix ids), and
// short on purpose: the operator's own. Missing or malformed config fails
// CLOSED with a 503 naming its remedy; not signed in, or signed in as anyone
// else, is a 403. A pass is 204 with X-Fourier-Identity, which Caddy copies
// onto the request it forwards (forward_auth copy_headers). The queue door on
// vesper checks that identity again against its own roster, so this gate is
// one of two locks, never the only one.
//
// It is on the EXISTING /verify route (ruling 2026-09-24: no new routes) as a
// query parameter, as gate=sample is.

const { doorPage } = require("./verify");

// @localpart:server, as the Matrix spec allows a user id.
const MXID_RE = /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-]+(:[0-9]+)?$/;

// Validated once at boot. Never throws: a broken config is reported (boot log,
// /healthz) and answered 503, because refusing to start would take every
// Matrix picture down with the board.
function parseOperatorGateConfig(env) {
  const raw = String(env.OPERATOR_GATE_MXIDS || "").trim();
  if (!raw) {
    return { ok: false, problem: "OPERATOR_GATE_MXIDS is unset. Set it to the operator's Matrix id in fourier-auth's " +
      "docker-compose.yaml environment and recreate the container." };
  }
  const mxids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = mxids.filter((m) => !MXID_RE.test(m));
  if (bad.length || !mxids.length) {
    return { ok: false, problem: `OPERATOR_GATE_MXIDS holds ${bad.map((b) => `"${b}"`).join(", ") || "nothing"}, ` +
      "which is not a Matrix user id (@name:server). Correct it in fourier-auth's docker-compose.yaml and recreate the container." };
  }
  return { ok: true, mxids };
}

function createOperatorGate({ config, log = console }) {
  // mxid -> { status, headers, body? }. Never throws.
  async function answer(mxid) {
    if (!config.ok) {
      log.error(`[operator-gate] refused (not configured): ${config.problem}`);
      return doorPage(503, `The operator's board is closed: its access check is not configured. ${config.problem}`);
    }
    if (!mxid) {
      return doorPage(403, "The operator's board needs you signed in to 41chan. Sign in at https://booru.41chan.net " +
        "or in Technetium (https://tc.41chan.net), then reload this page.");
    }
    if (!config.mxids.includes(mxid)) {
      return doorPage(403, `The operator's board is open only to the operator's own account, and you are signed in as ${mxid}. ` +
        "If that is the wrong account, sign out at https://booru.41chan.net and sign in as the right one.");
    }
    return { status: 204, headers: { "X-Fourier-Identity": mxid, "Cache-Control": "no-store" } };
  }
  return { answer };
}

module.exports = { createOperatorGate, parseOperatorGateConfig, MXID_RE };
