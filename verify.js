"use strict";

// GET /verify -- the identity resolver nginx `auth_request` calls to turn a
// fourier_session cookie into a verified MXID for the booru's Creator Gallery
// write gate.
//
// It ALWAYS returns 2xx: nginx auth_request treats any non-2xx as "deny the
// whole request", so a 401 here would break anonymous booru browsing. It sets
// the X-Fourier-Identity response header only when a real session resolves to a
// non-empty matrixUserId; otherwise it returns 204 with no header (anonymous).

// Pure mapping: a resolved session (or null) -> the identity to expose, or null.
function identityForSession(session) {
  return (session && typeof session.matrixUserId === "string" && session.matrixUserId) || null;
}

// Build the Express handler, with getSession + cookieName injected so it is
// testable without Redis or a live server. A getSession failure resolves to
// "anonymous" (204, no header) rather than blocking the request.
function makeVerifyHandler({ getSession, cookieName }) {
  return async function verifyHandler(req, res) {
    const sid = req.cookies ? req.cookies[cookieName] : undefined;
    let session = null;
    try {
      session = await getSession(sid);
    } catch (e) {
      session = null;
    }
    const identity = identityForSession(session);
    if (identity) res.set("X-Fourier-Identity", identity);
    return res.status(204).end();
  };
}

module.exports = { identityForSession, makeVerifyHandler };
