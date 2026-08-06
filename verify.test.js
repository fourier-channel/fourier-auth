"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { identityForSession, makeVerifyHandler } = require("./verify");

// Minimal res double that records what the handler did.
function fakeRes() {
  return {
    _status: null,
    _headers: {},
    _ended: false,
    set(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    status(c) { this._status = c; return this; },
    end() { this._ended = true; return this; },
  };
}
async function run(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test("identityForSession: only a non-empty matrixUserId yields an identity", () => {
  assert.equal(identityForSession(null), null);
  assert.equal(identityForSession({}), null);
  assert.equal(identityForSession({ matrixUserId: "" }), null);
  assert.equal(identityForSession({ matrixUserId: "@alice:41chan.net" }), "@alice:41chan.net");
});

test("no cookie -> 204 and NO X-Fourier-Identity header", async () => {
  const handler = makeVerifyHandler({ getSession: async () => null, cookieName: "fourier_session" });
  const res = await run(handler, { cookies: {} });
  assert.equal(res._status, 204);
  assert.equal(res._ended, true);
  assert.equal("x-fourier-identity" in res._headers, false);
});

test("valid session -> 204 and X-Fourier-Identity == matrixUserId", async () => {
  const handler = makeVerifyHandler({
    getSession: async (sid) => (sid === "good" ? { matrixUserId: "@alice:41chan.net", matrixToken: "t" } : null),
    cookieName: "fourier_session",
  });
  const res = await run(handler, { cookies: { fourier_session: "good" } });
  assert.equal(res._status, 204);
  assert.equal(res._headers["x-fourier-identity"], "@alice:41chan.net");
});

test("expired/invalid session -> 204 and NO identity header", async () => {
  const handler = makeVerifyHandler({ getSession: async () => null, cookieName: "fourier_session" });
  const res = await run(handler, { cookies: { fourier_session: "expired" } });
  assert.equal(res._status, 204);
  assert.equal("x-fourier-identity" in res._headers, false);
});

test("SAFETY: getSession throwing still returns 204 with no header (never blocks the request)", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => { throw new Error("redis down"); },
    cookieName: "fourier_session",
  });
  const res = await run(handler, { cookies: { fourier_session: "x" } });
  assert.equal(res._status, 204);
  assert.equal("x-fourier-identity" in res._headers, false);
});
