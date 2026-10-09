"use strict";

// GET /verify -- the identity resolver nginx `auth_request` calls to turn a
// fourier_session cookie into a verified MXID for the booru's Creator Gallery
// write gate.
//
// Bare, it ALWAYS returns 2xx: nginx auth_request treats any non-2xx as "deny
// the whole request", so a 401 here would break anonymous booru browsing. It
// sets the X-Fourier-Identity response header only when a real session resolves
// to a non-empty matrixUserId; otherwise it returns 204 with no header.
//
// With ?gate=<name> it is a door instead, and fails closed -- see `gates`.

// Pure mapping: a resolved session (or null) -> the identity to expose, or null.
function identityForSession(session) {
  return (session && typeof session.matrixUserId === "string" && session.matrixUserId) || null;
}

// A door's refusal is a PAGE with the way back (review repair 2026-10-09).
// The viewer meets it inside Technetium's centre panel, which has no address
// bar, so plain text there is a dead end and its URLs cannot be clicked. It
// carries ONE link: absolute, to the booru, no target -- it navigates the same
// frame, exactly like the sampling console's own way back (operator ruling
// 2026-10-09: "be absolutely sure that calling sample from within the booru
// from within sample doesn't cause a cascade"). No script, no frame, no
// refresh. Technetium's address may be named in the text but is never linked:
// followed inside tc's own panel, it would put Technetium inside Technetium.
// Every interpolated string is escaped: a room name is text anyone at the
// room's name level wrote.
const WAY_BACK = "https://booru.41chan.net/";
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function doorPage(status, text, extra = {}) {
  return {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
    body: "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<meta name=\"color-scheme\" content=\"light dark\"><title>Closed</title></head>\n" +
      `<body><p>${escapeHtml(text)}</p>\n<p><a href="${WAY_BACK}">Back to the booru</a></p></body></html>\n`,
  };
}
function sendPage(res, out) {
  for (const [k, v] of Object.entries(out.headers)) res.set(k, v);
  return res.status(out.status).send(out.body);
}

// Build the Express handler, with getSession + cookieName injected so it is
// testable without Redis or a live server. A getSession failure resolves to
// "anonymous" (204, no header) rather than blocking the request.
//
// `sessionInfo` (optional): async (sid, session) -> a JSON-able object for
// the X-Fourier-Session-Info header, or null. This is the session bar's
// evidence line -- expiry, the previous session's digest and end -- and it
// is strictly a bonus: any failure there leaves the identity standing and
// the info header absent, never the reverse.
//
// `gates` (optional): { name: async (mxid|null) -> { status, headers, body? } }.
// GET /verify?gate=<name> is a DIFFERENT contract from the bare route: it is a
// door, not a resolver, and it fails CLOSED. The gate decides the status; a
// session store that cannot be read is a 503, never "anonymous"; a gate name
// this service does not know is a 400, so a typo in the proxy config can never
// fall through to the always-204 answer above. No sessionInfo runs in a gate
// (it refreshes the session's Matrix token, which no gate uses, and a gate is
// asked on every request of a page that polls). Added for the sampling
// console on sample.41chan.net (operator ruling 2026-10-09; sample-gate.js),
// on this route because no new routes are added (ruling 2026-09-24).
function makeVerifyHandler({ getSession, cookieName, sessionInfo, gates = {} }) {
  return async function verifyHandler(req, res) {
    const sid = req.cookies ? req.cookies[cookieName] : undefined;
    const gateName = req.query ? req.query.gate : undefined;
    if (gateName !== undefined) {
      const gate = typeof gateName === "string" && Object.prototype.hasOwnProperty.call(gates, gateName) ? gates[gateName] : null;
      if (!gate) {
        return sendPage(res, doorPage(400, `Unknown gate. This service knows: ${Object.keys(gates).join(", ") || "none"}. ` +
          "Fix the gate= parameter in the proxy's forward_auth uri."));
      }
      let session;
      try {
        session = await getSession(sid);
      } catch (e) {
        console.error(`[verify] gate ${gateName}: session store unreadable: ${e.code || e.message}`);
        return sendPage(res, doorPage(503, "Closed: the session store could not be read, so who you are is unknown. " +
          "Check fourier-auth's /healthz (session store); retry in a minute.", { "Retry-After": "30" }));
      }
      const out = await gate(identityForSession(session));
      for (const [k, v] of Object.entries(out.headers || {})) res.set(k, v);
      res.status(out.status);
      return out.body === undefined ? res.end() : res.send(out.body);
    }
    let session = null;
    try {
      session = await getSession(sid);
    } catch (e) {
      session = null;
    }
    const identity = identityForSession(session);
    if (identity) {
      res.set("X-Fourier-Identity", identity);
      if (sessionInfo) {
        try {
          const info = await sessionInfo(sid, session);
          if (info && Object.keys(info).length) {
            res.set("X-Fourier-Session-Info", JSON.stringify(info));
          }
        } catch (e) {
          // The identity stands; the info line is a bonus, never a blocker.
        }
      }
    }
    return res.status(204).end();
  };
}

module.exports = { identityForSession, makeVerifyHandler, doorPage };
