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

// -- ?gate=<name>: a door, and it fails closed (operator ruling 2026-10-09) --

function fakeGateRes() {
  const r = fakeRes();
  r._body = undefined;
  r.send = function (b) { this._body = b; this._ended = true; return this; };
  return r;
}
async function runGate(handler, req) {
  const res = fakeGateRes();
  await handler(req, res);
  return res;
}
const passGate = async (mxid) => (mxid === "@saber:41chan.net"
  ? { status: 204, headers: { "X-Fourier-View": "internal", "X-Fourier-Identity": mxid } }
  : { status: 403, headers: { "Content-Type": "text/plain" }, body: "no\n" });

test("gate: the gate's answer is the answer -- 204 + its headers on pass, 403 + body on fail", async () => {
  let infoCalls = 0;
  const handler = makeVerifyHandler({
    getSession: async (sid) => (sid ? { matrixUserId: sid } : null),
    cookieName: "fourier_session",
    sessionInfo: async () => { infoCalls++; return { expires_at: 1 }; },
    gates: { sample: passGate },
  });
  const ok = await runGate(handler, { cookies: { fourier_session: "@saber:41chan.net" }, query: { gate: "sample" } });
  assert.equal(ok._status, 204);
  assert.equal(ok._headers["x-fourier-view"], "internal");
  assert.equal(ok._headers["x-fourier-identity"], "@saber:41chan.net");
  assert.equal("x-fourier-session-info" in ok._headers, false, "no session-info (and no token refresh) in a gate");
  assert.equal(infoCalls, 0);
  const no = await runGate(handler, { cookies: { fourier_session: "@maple:41chan.net" }, query: { gate: "sample" } });
  assert.equal(no._status, 403);
  assert.equal(no._body, "no\n");
  assert.equal("x-fourier-identity" in no._headers, false);
});

test("gate: no cookie reaches the gate as null (the gate says sign in), not as a 204", async () => {
  const seen = [];
  const handler = makeVerifyHandler({
    getSession: async () => null,
    cookieName: "fourier_session",
    gates: { sample: async (mxid) => { seen.push(mxid); return { status: 403, body: "sign in\n" }; } },
  });
  const res = await runGate(handler, { cookies: {}, query: { gate: "sample" } });
  assert.equal(res._status, 403);
  assert.deepEqual(seen, [null]);
});

test("gate SAFETY: a session store that throws is 503 -- never anonymous, never 204", async () => {
  let asked = 0;
  const handler = makeVerifyHandler({
    getSession: async () => { throw Object.assign(new Error("redis down"), { code: "ECONNREFUSED" }); },
    cookieName: "fourier_session",
    gates: { sample: async () => { asked++; return { status: 204 }; } },
  });
  const orig = console.error; console.error = () => {};
  try {
    const res = await runGate(handler, { cookies: { fourier_session: "x" }, query: { gate: "sample" } });
    assert.equal(res._status, 503);
    assert.match(res._body, /session store/);
    assert.equal(asked, 0);
  } finally { console.error = orig; }
});

test("gate SAFETY: an unknown or repeated gate= is 400, never the bare route's 204", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => ({ matrixUserId: "@saber:41chan.net" }),
    cookieName: "fourier_session",
    gates: { sample: passGate },
  });
  for (const gate of ["sampel", "", "__proto__", "toString", ["sample", "sample"]]) {
    const res = await runGate(handler, { cookies: { fourier_session: "s" }, query: { gate } });
    assert.equal(res._status, 400, JSON.stringify(gate));
    assert.match(res._body, /Unknown gate\. This service knows: sample\./);
    assert.equal("x-fourier-identity" in res._headers, false);
  }
});

test("gate: the bare route is unchanged by a gates map (no query -> the always-204 resolver)", async () => {
  const handler = makeVerifyHandler({
    getSession: async () => null,
    cookieName: "fourier_session",
    gates: { sample: async () => ({ status: 403 }) },
  });
  const res = await run(handler, { cookies: {}, query: {} });
  assert.equal(res._status, 204);
});

test("gate: verify's own refusals (unknown gate, session store) are pages with the way back to the booru", async () => {
  const handler = makeVerifyHandler({
    getSession: async (sid) => { if (sid === "boom") throw new Error("redis down"); return null; },
    cookieName: "fourier_session",
    gates: { sample: passGate },
  });
  const orig = console.error; console.error = () => {};
  try {
    for (const [cookie, gate, status] of [["s", "sampel", 400], ["boom", "sample", 503]]) {
      const res = await runGate(handler, { cookies: { fourier_session: cookie }, query: { gate } });
      assert.equal(res._status, status);
      assert.equal(res._headers["content-type"], "text/html; charset=utf-8");
      assert.equal(res._headers["cache-control"], "no-store");
      assert.deepEqual(res._body.match(/<a\b[^>]*>/gi), ['<a href="https://booru.41chan.net/">']);
      assert.doesNotMatch(res._body, /target=|<script|<iframe|window\.open/i);
    }
  } finally { console.error = orig; }
});
