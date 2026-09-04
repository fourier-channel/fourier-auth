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

test("session info: emitted beside the identity when the dep delivers", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => ({ matrixUserId: "@alice:41chan.net", createdAt: 1000 }),
    cookieName: "fourier_session",
    sessionInfo: async (sid, session) => ({ expires_at: 123, previous_digest: "abcd1234", previous_ended_at: 99 }),
  });
  const res = await run(handler, { cookies: { fourier_session: "sid1" } });
  assert.equal(res._status, 204);
  assert.equal(res._headers["x-fourier-identity"], "@alice:41chan.net");
  assert.deepEqual(JSON.parse(res._headers["x-fourier-session-info"]), {
    expires_at: 123, previous_digest: "abcd1234", previous_ended_at: 99,
  });
});

test("session info: never emitted for an anonymous request", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => null,
    cookieName: "fourier_session",
    sessionInfo: async () => ({ expires_at: 123 }),
  });
  const res = await run(handler, { cookies: { fourier_session: "dead" } });
  assert.equal("x-fourier-session-info" in res._headers, false);
  assert.equal("x-fourier-identity" in res._headers, false);
});

test("session info: a throwing dep leaves the identity standing, info absent", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => ({ matrixUserId: "@alice:41chan.net" }),
    cookieName: "fourier_session",
    sessionInfo: async () => { throw new Error("redis died"); },
  });
  const res = await run(handler, { cookies: { fourier_session: "sid1" } });
  assert.equal(res._status, 204);
  assert.equal(res._headers["x-fourier-identity"], "@alice:41chan.net");
  assert.equal("x-fourier-session-info" in res._headers, false);
});

test("session info: an empty object emits no header", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => ({ matrixUserId: "@alice:41chan.net" }),
    cookieName: "fourier_session",
    sessionInfo: async () => ({}),
  });
  const res = await run(handler, { cookies: { fourier_session: "sid1" } });
  assert.equal("x-fourier-session-info" in res._headers, false);
});
