"use strict";

// GET /booru/:file, driven with fake req/res and every dependency injected.
// The leak audit's F-G1 and F-G2 (2026-10-01), end to end through the route:
//
//   F-G1  bytes by md5 only for a post the requester may see -- originals AND
//         variants; the booru being unreachable is a 503, never a yes.
//   F-G2  a presigned URL only to the edge Worker; anyone else gets the
//         decision and no URL, no 302, no byte.

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBooruHandler } = require("./booru-route");
const { parseBooruFile, pickVariant, booruR2Key, saveDisposition } = require("./booru-media");
const { sendRelease } = require("./release");
const { BooruUnavailable } = require("./booru-visibility");
const { GateSignals } = require("./gateSignals");
const { isEdgeCaller } = require("./callers");
const { pubHashes, PublicationsUnavailable } = require("./publication-grants");

const VISIBLE = "a".repeat(32);
const JAILED = "b".repeat(32);
const SECRET = "test-edge-secret";
// A restricted-tag image: hidden from a signed-out reader by the booru, shown
// on the live publication PUB.
const RESTRICTED = "c".repeat(32);
const PUB = "d".repeat(32);

function harness(over = {}) {
  const presigned = [];
  const asked = [];
  const pubAsks = [];
  const signals = new GateSignals(() => 1_000_000);
  const logs = [];
  const d = {
    parseBooruFile, pickVariant, booruR2Key, saveDisposition, sendRelease,
    applyCors: () => {},
    r2Enabled: true,
    requireSession: false,
    getSession: async () => null,
    cookieName: "fourier_session",
    booruCookieName: "_danbooru2_session",
    clientIp: () => null,
    isMatrixImage: async () => false,
    originalExists: async () => true,
    visibility: { sees: async (md5, viewer) => { asked.push({ md5, viewer }); return md5 === VISIBLE; } },
    presign: async (key, disp) => { presigned.push({ key, disp }); return `https://acct.r2.example/bucket/${key}?X-Amz-Credential=AKIA%2Fx&X-Amz-Signature=sig`; },
    isEdge: (headers) => isEdgeCaller(headers, SECRET),
    pubHashes,
    publications: { grants: async (md5, hashes) => { pubAsks.push({ md5, hashes }); return hashes.includes(PUB) && md5 === RESTRICTED; } },
    signals,
    log: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    ...over,
  };
  return { handler: makeBooruHandler(d), presigned, asked, pubAsks, signals, logs };
}

function call(handler, file, { query = {}, headers = {}, cookies = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined, location: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; return this; },
    redirect(c, l) { this.statusCode = c; this.location = l; return this; },
  };
  const req = { params: { file }, query, headers, cookies };
  return Promise.resolve(handler(req, res)).then(() => res);
}

const EDGE = { "x-fourier-edge": SECRET, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

function leaksCredential(res) {
  const s = JSON.stringify({ b: res.body, l: res.location, h: res.headers });
  return /X-Amz|r2\.example/.test(s);
}

// -- F-G1 ---------------------------------------------------------------------

test("F-G1: a jailed or never-posted md5 is refused -- original AND every variant", async () => {
  const { handler, presigned } = harness();
  for (const query of [{}, { w: "180", h: "180" }, { w: "360" }, { w: "720" }, { dl: "1" }]) {
    const res = await call(handler, `${JAILED}.jpg`, { query, headers: EDGE });
    assert.equal(res.statusCode, 404, JSON.stringify(query));
    assert.ok(!leaksCredential(res));
  }
  assert.equal(presigned.length, 0, "nothing was even signed");
});

test("F-G1: a visible post's original and variants are released to the edge", async () => {
  const { handler, presigned } = harness();
  const orig = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.equal(orig.statusCode, 200);
  assert.match(orig.body.url, /media\/a{32}\.png/);
  const thumb = await call(handler, `${VISIBLE}.jpg`, { query: { w: "180", h: "180" }, headers: EDGE });
  assert.match(thumb.body.url, /variants\/a{32}\/180x180\.jpg/);
  assert.equal(presigned.length, 2);
});

test("F-G1: the booru unreachable is a 503 with Retry-After, logged and RED -- never bytes", async () => {
  const { handler, signals, logs, presigned } = harness({
    visibility: { sees: async () => { throw new BooruUnavailable(new Error("connect ECONNREFUSED")); } },
  });
  const res = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "2");
  assert.equal(presigned.length, 0);
  assert.ok(logs.some((l) => /BOORU UNREACHABLE/.test(l)), "loud");
  assert.equal(signals.health().level, "red");
});

test("F-G1: the reader's own booru session is offered to the booru, with the address the edge vouched for", async () => {
  const { handler, asked } = harness({ clientIp: (h) => (h["x-fourier-edge"] === SECRET ? "203.0.113.9" : null) });
  await call(handler, `${JAILED}.jpg`, { headers: EDGE, cookies: { _danbooru2_session: "s3ss", fourier_session: "fs" } });
  assert.deepEqual(asked[0].viewer, { sessionCookie: "s3ss", clientIp: "203.0.113.9" });
  // And no booru session: anonymous, nothing invented.
  await call(handler, `${JAILED}.jpg`, { headers: EDGE, cookies: { fourier_session: "fs" } });
  assert.equal(asked[1].viewer, null);
});

test("F-G1: a Matrix image is still refused at this door before the booru is asked", async () => {
  const { handler, asked } = harness({ isMatrixImage: async () => true });
  const res = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.equal(res.statusCode, 404);
  assert.equal(asked.length, 0);
});

test("an original no longer in the bucket is refused even when its post is visible", async () => {
  const { handler } = harness({ originalExists: async () => false });
  const res = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.equal(res.statusCode, 404);
});

// -- F-G2 ---------------------------------------------------------------------

test("F-G2: a direct caller gets the decision and NO presigned URL, in either release shape", async () => {
  const { handler, presigned } = harness();
  for (const headers of [
    {},                                                            // curl
    { "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" },    // <img> straight at the gate
    { "sec-fetch-mode": "cors" },                                  // fetch()
    { "x-fourier-edge": "a-guess" },                               // a wrong secret
  ]) {
    const res = await call(handler, `${VISIBLE}.png`, { headers });
    assert.equal(res.statusCode, 200, JSON.stringify(headers));
    assert.equal(res.location, undefined, "no 302");
    assert.deepEqual({ allowed: res.body.allowed, released: res.body.released }, { allowed: true, released: false });
    assert.ok(!leaksCredential(res), JSON.stringify(res.body));
    assert.equal(res.headers["cache-control"], "no-store");
  }
  assert.equal(presigned.length, 0, "nothing signed for a caller who will not be handed it");
});

test("F-G2: the edge's native load still gets its 302, a cors fetch its envelope", async () => {
  const { handler } = harness();
  const nav = await call(handler, `${VISIBLE}.png`, { headers: { "x-fourier-edge": SECRET, "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" } });
  assert.equal(nav.statusCode, 302);
  assert.match(nav.location, /X-Amz/);
  const env = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.match(env.body.url, /X-Amz/);
});

test("F-G2: with no secret configured, nobody is the edge", async () => {
  const { handler } = harness({ isEdge: (h) => isEdgeCaller(h, "") });
  const res = await call(handler, `${VISIBLE}.png`, { headers: { "x-fourier-edge": "" } });
  assert.equal(res.body.released, false);
});

// -- a published page's grant (operator ruling 2026-10-02) -------------------

test("PUB: a restricted md5 a live publication shows is released to its reader", async () => {
  const { handler, presigned, signals } = harness();
  const res = await call(handler, `${RESTRICTED}.jpg`, { query: { w: "360" }, headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /variants\/c{32}\/360x360/);
  assert.equal(presigned.length, 1);
  assert.equal(signals.counts().publication_grants, 1);
});

test("PUB: without the cookie, or with another page's, the booru's no stands", async () => {
  const { handler, pubAsks } = harness();
  assert.equal((await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE })).statusCode, 404);
  assert.equal(pubAsks.length, 0, "no cookie, no question");
  assert.equal((await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE, cookies: { [`fourier_pub_${"e".repeat(32)}`]: "1" } })).statusCode, 404);
});

test("PUB: an md5 that is not on the page, or a jailed one, is refused even with the cookie", async () => {
  const { handler } = harness();
  const ck = { cookies: { [`fourier_pub_${PUB}`]: "1" }, headers: EDGE };
  assert.equal((await call(handler, `${JAILED}.jpg`, ck)).statusCode, 404);
});

test("PUB: a visible md5 never asks the publication at all", async () => {
  const { handler, pubAsks } = harness();
  await call(handler, `${VISIBLE}.png`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(pubAsks.length, 0);
});

test("PUB: the route passes at most 8 well-formed grants, in the order they came", async () => {
  const { handler, pubAsks } = harness();
  const cookies = { fourier_pub_bogus: "1" };
  for (let i = 0; i < 11; i++) cookies[`fourier_pub_${i.toString(16).padStart(32, "f")}`] = "1";
  await call(handler, `${JAILED}.jpg`, { headers: EDGE, cookies });
  assert.equal(pubAsks[0].hashes.length, 8);
  assert.ok(pubAsks[0].hashes.every((h) => /^[0-9a-f]{32}$/.test(h)));
});

test("PUB: sampling unreachable is a 503 for the publication path only, loud and RED", async () => {
  const { handler, logs, signals, presigned } = harness({
    publications: { grants: async () => { throw new PublicationsUnavailable(new Error("connect ETIMEDOUT")); } },
  });
  const res = await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(res.statusCode, 503);
  assert.equal(presigned.length, 0);
  assert.ok(logs.some((l) => /SAMPLING UNREACHABLE/.test(l)));
  assert.equal(signals.health().checks.find((c) => c.id === "publication-grants").level, "red");
  // The ordinary booru path does not touch sampling.
  const ok = await call(handler, `${VISIBLE}.png`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(ok.statusCode, 200);
});
