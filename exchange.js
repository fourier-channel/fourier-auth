"use strict";
// Zero-click booru session for a Technetium user (operator ruling 2026-09-06).
//
// Technetium (tc.41chan.net) holds a Matrix access token; the booru
// (booru.41chan.net) gates media on the fourier_session cookie. The two are
// the same SITE (41chan.net), so a credentialed cross-origin POST from
// Technetium can set that cookie -- if the token is proven to be ours first.
// This module is the pure part: which origins may ask, and what the answer
// to a preflight is. index.js wires it to whoami and createSession.

function exchangeCorsHeaders(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Vary": "Origin",
  };
}

// The token out of an Authorization header, or null. Only Bearer.
function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || "");
  return m ? m[1] : null;
}

module.exports = { exchangeCorsHeaders, bearerToken };
