"use strict";

// GET /media/:serverName/:mediaId, driven with fake req/res and every
// dependency injected (media-route.js). Mostly the TOKENLESS RELEASE (operator
// ruling 2026-11-01): a request with no token is let through gate 3 only for
// a local image a signed-out viewer may see on the booru -- a Matrix post the
// booru's anonymous ask answers for while a public gallery's grant is fresh.
// Everything else a tokenless request gets is today's 401, byte for byte; and
// a request WITH a token never takes this path, refused or not.

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeMediaHandler } = require("./media-route");
const { sendRelease } = require("./release");
const { BooruUnavailable } = require("./booru-visibility");
const { GateSignals } = require("./gateSignals");
const { isEdgeCaller } = require("./callers");
const { MediaAuthUnavailable } = require("./mediaauth-core");
const { OriginalUnavailable } = require("./mediar2");

const SECRET = "test-edge-secret";
const EDGE = { "x-fourier-edge": SECRET, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
const HS = "41chan.net";
// A Matrix post a public gallery has shown a signed-out visitor: the booru's
// anonymous ask answers for its md5.
const GALLERIED = "a".repeat(32);
const GALLERIED_ID = "galleriedMediaId";
// A Matrix image nobody has put on a public gallery.
const PRIVATE_ID = "privateMediaId";
const PRIVATE = "b".repeat(32);
// A galleried image whose post now carries a flagged tag.
const FLAGGED_ID = "flaggedMediaId";
const FLAGGED = "c".repeat(32);
// An image known under two md5s (its one file and the raw upload), only the
// second of which a galleried post holds.
const TWO_ID = "twoMd5MediaId";
const TWO_RAW = "d".repeat(32);
// Canon has no file for it (GONE/WITHHELD): localMd5s answers [].
const GONE_ID = "goneMediaId";
const UNLEARNABLE_ID = "canonDownMediaId";
// An id no index names: made up, or not yet canonical. The tokenless path
// never asks canon to make it (review 2026-11-01: a stranger's 401 must cost
// nothing past an index read), so it is a plain 401.
const UNKNOWN_ID = "madeUpMediaId";
const NO_TOKEN_401 = { error: "no valid session or bearer token" };

const MD5S = {
  [GALLERIED_ID]: [GALLERIED],
  [PRIVATE_ID]: [PRIVATE],
  [FLAGGED_ID]: [FLAGGED],
  [TWO_ID]: [PRIVATE, TWO_RAW],
  [GONE_ID]: [],
};

function harness(over = {}) {
  const presigned = [];
  const asked = [];
  const decided = [];
  const logs = [];
  const canonAsks = [];
  const indexReads = [];
  const signals = new GateSignals(() => 1_000_000);
  const d = {
    allowedThumbSizes: [180, 320, 360, 720, 850],
    applyCors: () => {},
    getSession: async (sid) => (sid === "live" ? { matrixToken: "tok" } : sid === "dead" ? { matrixToken: null } : null),
    cookieName: "fourier_session",
    freshToken: async (_sid, session) => session.matrixToken,
    decideMediaAccess: async (token, serverName, mediaId) => {
      decided.push({ token, serverName, mediaId });
      return token === "member" ? { allowed: true } : { allowed: false, reason: "not_member" };
    },
    homeserverName: HS,
    r2Enabled: true,
    // The token path's md5s: canon is asked when there is no index yet.
    localMd5s: async (mediaId) => {
      canonAsks.push(mediaId);
      return MD5S[mediaId] || [];
    },
    // The tokenless path's: only an index that already exists, canon never asked.
    localMd5sKnown: async (mediaId) => {
      indexReads.push(mediaId);
      if (mediaId === UNLEARNABLE_ID) throw Object.assign(new Error("R2 GetObject: 503 SlowDown"), { name: "SlowDown" });
      return MD5S[mediaId] || [];
    },
    visibility: {
      sees: async (md5, viewer) => { asked.push({ md5, viewer }); return md5 === GALLERIED || md5 === FLAGGED || md5 === TWO_RAW; },
    },
    quarantine: { check: ({ md5 }) => (md5 === FLAGGED ? "refuse" : "allow") },
    resolveR2Key: async ({ serverName, mediaId, thumbSize }) => `media/${serverName}/${mediaId}${thumbSize ? `/${thumbSize}` : ""}`,
    presign: async (key) => { presigned.push(key); return `https://acct.r2.example/bucket/${key}?X-Amz-Signature=sig`; },
    isEdge: (headers) => isEdgeCaller(headers, SECRET),
    sendRelease,
    signals,
    log: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    ...over,
  };
  return { handler: makeMediaHandler(d), presigned, asked, decided, logs, signals, canonAsks, indexReads };
}

function call(handler, serverName, mediaId, { query = {}, headers = {}, cookies = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined, location: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; return this; },
    redirect(c, l) { this.statusCode = c; this.location = l; return this; },
  };
  const req = { params: { serverName, mediaId }, query, headers, cookies };
  return Promise.resolve(handler(req, res)).then(() => res);
}

// -- the tokenless release ----------------------------------------------------

test("tokenless, the booru's anonymous answer is yes: released, flagged anonymous for the edge, and counted", async () => {
  const { handler, presigned, asked, decided, signals, canonAsks } = harness();
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /media\/41chan\.net\/galleriedMediaId/);
  assert.equal(res.body.anonymous, true, "the edge keeps it as a signed-out allow");
  assert.deepEqual(canonAsks, [], "canon never asked on the tokenless path");
  assert.deepEqual(asked, [{ md5: GALLERIED, viewer: null }], "asked as a signed-out viewer");
  assert.equal(decided.length, 0, "no room check: there is no token to check");
  assert.equal(presigned.length, 1);
  assert.equal(signals.counts().anonymous_matrix_releases, 1);
});

test("tokenless, a thumbnail of a galleried image is released at its snapped size", async () => {
  const { handler } = harness();
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE, query: { w: "300", h: "300" } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /galleriedMediaId\/320/);
});

test("tokenless, any one of the image's md5s answering yes is enough", async () => {
  const { handler, asked } = harness();
  const res = await call(handler, HS, TWO_ID, { headers: EDGE });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(asked.map((a) => a.md5), [PRIVATE, TWO_RAW]);
});

test("tokenless, the anonymous answer is no: the SAME 401 as before the ruling, counted", async () => {
  const { handler, presigned, signals } = harness();
  const res = await call(handler, HS, PRIVATE_ID, { headers: EDGE });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, NO_TOKEN_401);
  assert.deepEqual(res.headers, {}, "no header the old 401 did not carry");
  assert.equal(presigned.length, 0);
  assert.equal(signals.counts().anonymous_matrix_refusals, 1);
  assert.equal(signals.health().level, "ok", "a refused stranger is the gate working");
});

test("tokenless, an image canon has no file for (gone, withheld) is the same 401, the booru never asked", async () => {
  const { handler, asked } = harness();
  const res = await call(handler, HS, GONE_ID, { headers: EDGE });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, NO_TOKEN_401);
  assert.equal(asked.length, 0);
});

test("tokenless, an id no index names (made up, or not canonical yet): the same 401, canon and the booru never asked", async () => {
  const { handler, asked, canonAsks, presigned } = harness();
  const res = await call(handler, HS, UNKNOWN_ID, { headers: EDGE });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, NO_TOKEN_401);
  assert.deepEqual(canonAsks, []);
  assert.equal(asked.length, 0);
  assert.equal(presigned.length, 0);
});

test("tokenless, the booru unreachable: 503 with Retry-After, logged with its remedy and RED -- never a release", async () => {
  const { handler, presigned, logs, signals } = harness({
    visibility: { sees: async () => { throw new BooruUnavailable(new Error("connect ECONNREFUSED")); } },
  });
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "2");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(presigned.length, 0);
  assert.ok(logs.some((l) => /BOORU UNREACHABLE/.test(l) && /BOORU_INTERNAL_URL/.test(l)), "loud, and names the fix");
  assert.equal(signals.health().level, "red");
});

test("tokenless, the image's index unreadable (R2 failing): 503 with Retry-After, logged with its remedy", async () => {
  const { handler, presigned, asked, logs } = harness();
  const res = await call(handler, HS, UNLEARNABLE_ID, { headers: EDGE });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "2");
  assert.equal(presigned.length, 0);
  assert.equal(asked.length, 0);
  assert.ok(logs.some((l) => /could not learn its md5/.test(l) && /R2/.test(l)));
});

test("tokenless, the booru's error that is not BooruUnavailable is still a 503, never a release", async () => {
  const { handler, presigned } = harness({
    visibility: { sees: async () => { throw new TypeError("boom"); } },
  });
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 503);
  assert.equal(presigned.length, 0);
});

test("tokenless, a galleried image whose post is now flagged: refused exactly as a token holder is", async () => {
  const { handler, presigned, signals } = harness();
  const res = await call(handler, HS, FLAGGED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { errcode: "M_NOT_FOUND", error: "No such image." });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(presigned.length, 0);
  assert.equal(signals.counts().quarantine_refused, 1);
});

test("tokenless, a REMOTE server's media: the same 401, the booru never asked", async () => {
  const { handler, asked } = harness();
  const res = await call(handler, "matrix.org", GALLERIED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, NO_TOKEN_401);
  assert.equal(asked.length, 0);
});

test("tokenless, an id not shaped like a media id (over-long, a newline, a path): the same 401, nothing read", async () => {
  for (const bad of ["x".repeat(1100), "abc\nFAKE LINE", "../index/local/x"]) {
    const { handler, asked, indexReads } = harness();
    const res = await call(handler, HS, bad, { headers: EDGE });
    assert.equal(res.statusCode, 401, bad.slice(0, 20));
    assert.deepEqual(res.body, NO_TOKEN_401);
    assert.equal(indexReads.length, 0);
    assert.equal(asked.length, 0);
  }
});

test("tokenless, a galleried image the quarantine refuses is not counted as released", async () => {
  const { handler, signals } = harness();
  await call(handler, HS, FLAGGED_ID, { headers: EDGE });
  assert.equal(signals.counts().anonymous_matrix_releases || 0, 0);
});

test("tokenless, R2 not configured: the same 401, the booru never asked", async () => {
  const { handler, asked } = harness({ r2Enabled: false });
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, NO_TOKEN_401);
  assert.equal(asked.length, 0);
});

test("a session whose token is dead is a tokenless request: asked anonymously, and its release says so", async () => {
  // The Worker cannot see a dead session -- it sees a fourier_session cookie
  // -- so the gate tells it, and the allow is kept 60 s, not 150 (review
  // 2026-11-01). Same for an empty cookie, "Bearer " with nothing after it, a
  // scheme that is not Bearer, an unrenewable session.
  const { handler, asked } = harness();
  for (const ask of [
    { cookies: { fourier_session: "dead" } },
    { cookies: { fourier_session: "" } },
    { headers: { authorization: "Bearer " } },
    { headers: { authorization: "Basic dXNlcjpwYXNz" } },
  ]) {
    const res = await call(handler, HS, GALLERIED_ID, { headers: { ...EDGE, ...(ask.headers || {}) }, cookies: ask.cookies || {} });
    assert.equal(res.statusCode, 200, JSON.stringify(ask));
    assert.equal(res.body.anonymous, true, JSON.stringify(ask));
  }
  assert.equal(asked.length, 4);
});

test("tokenless, not the edge: the decision and nothing it could fetch with (F-G2), and no new field", async () => {
  const { handler, presigned } = harness();
  const res = await call(handler, HS, GALLERIED_ID, {});
  assert.deepEqual(Object.keys(res.body).sort(), ["allowed", "error", "released"]);
  assert.equal(res.body.allowed, true);
  assert.equal(res.body.released, false);
  assert.equal(presigned.length, 0);
});

// -- a request WITH a token keeps today's path --------------------------------

test("a Bearer refused by the room check: 403, and the booru is never asked", async () => {
  const { handler, asked, presigned } = harness();
  const res = await call(handler, HS, GALLERIED_ID, { headers: { ...EDGE, authorization: "Bearer outsider" } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "not authorized for this media" });
  assert.equal(asked.length, 0, "no fall back to the anonymous answer");
  assert.equal(presigned.length, 0);
});

test("a live session refused by the room check: 403, counted on the session lamp, the booru never asked", async () => {
  const { handler, asked, signals } = harness();
  const res = await call(handler, HS, GALLERIED_ID, { headers: EDGE, cookies: { fourier_session: "live" } });
  assert.equal(res.statusCode, 403);
  assert.equal(asked.length, 0);
  assert.equal(signals.counts().session_refusals, 1);
});

test("a Bearer the room check allows is released without an anonymous ask, unflagged, its md5s asked of canon", async () => {
  const { handler, asked, decided, canonAsks } = harness();
  const res = await call(handler, HS, PRIVATE_ID, { headers: { ...EDGE, authorization: "Bearer member" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body), ["url"], "a token holder's allow carries no anonymous flag");
  assert.equal(decided.length, 1);
  assert.equal(asked.length, 0);
  assert.deepEqual(canonAsks, [PRIVATE_ID], "the token path learns md5s with canon, as before");
});

test("the room check unavailable is today's 503 with Retry-After 1", async () => {
  const { handler } = harness({ decideMediaAccess: async () => { throw new MediaAuthUnavailable(new Error("pool timeout")); } });
  const res = await call(handler, HS, PRIVATE_ID, { headers: { ...EDGE, authorization: "Bearer member" } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "1");
});

test("a token holder's flagged image is still refused by the quarantine", async () => {
  const { handler } = harness();
  const res = await call(handler, HS, FLAGGED_ID, { headers: { ...EDGE, authorization: "Bearer member" } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { errcode: "M_NOT_FOUND", error: "No such image." });
});
