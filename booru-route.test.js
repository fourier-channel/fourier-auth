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
const { QuarantineUnavailable } = require("./booru-quarantine");

const VISIBLE = "a".repeat(32);
const JAILED = "b".repeat(32);
const SECRET = "test-edge-secret";
// A restricted-tag image: hidden from a signed-out reader by the booru, shown
// on the live publication PUB.
const RESTRICTED = "c".repeat(32);
const PUB = "d".repeat(32);
// A post the booru shows that was posted FROM Matrix (source mxc://...): its
// file is a Matrix image's one file and is served only through the Matrix door.
const MATRIX_POSTED = "e".repeat(32);
const MXC_ID = "qjbTsnSicsuUyzSjxsOidXSJ";
// A restricted-tag image a live publication shows, whose post now carries a
// flagged (or banished) tag: in the booru's quarantine document.
const QUARANTINED = "f".repeat(32);
// A FLAGGED post that came from Matrix (source mxc://): its file is a Matrix
// image's one file, in the quarantine document, and refused at this door to
// everyone -- an Admin whose own booru session sees the post included.
const FLAGGED_MXC = "9".repeat(32);
const ADMIN_COOKIE = { cookie: "_danbooru2_session=ADMIN%2Bsess" };

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
    visibility: {
      sees: async (md5, viewer) => { asked.push({ md5, viewer }); return md5 === VISIBLE || md5 === MATRIX_POSTED; },
      // VISIBLE is a 4chan-sourced post; MATRIX_POSTED is mxc-sourced.
      seesNonMatrix: async (md5, viewer) => { asked.push({ md5, viewer, nonMatrix: true }); return md5 === VISIBLE; },
    },
    matrixIndexOf: async (md5) => ({ mxc_media_id: MXC_ID, key: `media/${md5}.png` }),
    presign: async (key, disp) => { presigned.push({ key, disp }); return `https://acct.r2.example/bucket/${key}?X-Amz-Credential=AKIA%2Fx&X-Amz-Signature=sig`; },
    isEdge: (headers) => isEdgeCaller(headers, SECRET),
    pubHashes,
    publications: { grants: async (md5, hashes) => { pubAsks.push({ md5, hashes }); return hashes.includes(PUB) && (md5 === RESTRICTED || md5 === QUARANTINED); } },
    quarantine: {
      check: ({ md5 }) => (md5 === QUARANTINED || md5 === FLAGGED_MXC ? "refuse" : "allow"),
    },
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

test("F-G1: the booru session is forwarded exactly as the browser sent it, never URL-decoded", async () => {
  // Live 2026-10-02: Gold readers were refused restricted images. Rails' session
  // cookie is escaped base64; cookie-parser decodes %2B to "+", and Rack reads a
  // literal "+" in a cookie as a space, so the forwarded session never decrypted.
  const { handler, asked } = harness({ clientIp: () => "203.0.113.9" });
  const sent = "QUJD%2Bk%2Fz%3D%3D--aXY%3D--dGFn%3D%3D";
  await call(handler, `${JAILED}.jpg`, {
    headers: { ...EDGE, cookie: `fourier_session=fs; _danbooru2_session=${sent}; other=1` },
    cookies: { _danbooru2_session: decodeURIComponent(sent), fourier_session: "fs", other: "1" },
  });
  assert.equal(asked[0].viewer.sessionCookie, sent);
  // A caller with only the parsed jar gets Rack's escaping back.
  await call(handler, `${JAILED}.jpg`, { headers: EDGE, cookies: { _danbooru2_session: decodeURIComponent(sent) } });
  assert.equal(asked[1].viewer.sessionCookie, sent);
});

// ONE FILE, TWO DOORS -- and a file can be both. Live 2026-10-05: a 4chan
// image the booru had posted on 2026-10-04 (post 745131) was posted again in
// Matrix; canon adopted the booru's file as the Matrix image's one file and
// wrote index/md5/<md5>.json, and this door then refused the booru post's
// original and every thumbnail with a silent 404. Thirteen live non-Matrix
// posts were refused the same way, post 1 since the 2026-09-30 backfill.
// "Some Matrix id uses this file" is not "this file is only Matrix's".

test("F-G1 (a): a file a Matrix id shares with a visible non-Matrix post is released as that post -- original and variants", async () => {
  const { handler, presigned, signals } = harness({ isMatrixImage: async () => true });
  const orig = await call(handler, `${VISIBLE}.png`, { headers: EDGE });
  assert.equal(orig.statusCode, 200);
  assert.match(orig.body.url, /media\/a{32}\.png/);
  const thumb = await call(handler, `${VISIBLE}.jpg`, { query: { w: "180", h: "180" }, headers: EDGE });
  assert.equal(thumb.statusCode, 200);
  assert.match(thumb.body.url, /variants\/a{32}\/180x180\.jpg/);
  assert.equal(presigned.length, 2);
  assert.equal(signals.counts().matrix_refused, 0, "a release is not a refusal");
});

test("F-G1 (b): a Matrix image whose only post came from Matrix is refused at this door -- original and variants", async () => {
  const { handler, presigned } = harness({ isMatrixImage: async () => true });
  for (const query of [{}, { w: "180", h: "180" }]) {
    const res = await call(handler, `${MATRIX_POSTED}.png`, { query, headers: EDGE });
    assert.equal(res.statusCode, 404, JSON.stringify(query));
    assert.ok(!leaksCredential(res));
  }
  assert.equal(presigned.length, 0, "nothing was even signed");
});

test("F-G1 (c): a Matrix image with no post is refused, logged with its remedy, and signalled with its mxc id", async () => {
  const { handler, presigned, signals, logs } = harness({ isMatrixImage: async () => true });
  const res = await call(handler, `${JAILED}.png`, { headers: EDGE });
  assert.equal(res.statusCode, 404);
  assert.equal(presigned.length, 0);
  assert.equal(signals.counts().matrix_refused, 1);
  assert.match(signals.last.matrix_refused, new RegExp(MXC_ID));
  assert.equal(signals.health().checks.find((x) => x.id === "booru-matrix-refused").level, "amber");
  const line = logs.find((l) => l.includes(JAILED));
  assert.ok(line, "the refusal is logged");
  assert.match(line, new RegExp(MXC_ID));
  assert.match(line, /Fix: /);
  // The mxc id being unreadable changes the words, never the answer.
  const broken = harness({ isMatrixImage: async () => true, matrixIndexOf: async () => { throw new Error("NoSuchKey"); } });
  const again = await call(broken.handler, `${JAILED}.png`, { headers: EDGE });
  assert.equal(again.statusCode, 404);
  assert.match(broken.signals.last.matrix_refused, /mxc id unreadable: NoSuchKey/);
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

// -- the quarantine (operator rulings 2026-10-12: flagged and banished tags
// disappear everywhere, like jail -- a publication's grant included) --------

test("QUARANTINE: a quarantined md5 is refused even with a live grant cookie, and the page is never asked", async () => {
  const { handler, presigned, pubAsks, signals } = harness();
  for (const query of [{}, { w: "360" }]) {
    const res = await call(handler, `${QUARANTINED}.jpg`, { query, headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
    assert.equal(res.statusCode, 404, JSON.stringify(query));
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(!leaksCredential(res));
  }
  assert.equal(presigned.length, 0);
  assert.equal(pubAsks.length, 0, "the grant is not even consulted");
  assert.equal(signals.counts().quarantine_refused, 2);
  // A restricted md5 that is not quarantined is still granted.
  const res = await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(res.statusCode, 200);
});

test("QUARANTINE: unreadable on the grant path is a 503, loud and RED; the booru path is untouched", async () => {
  const { handler, logs, signals, presigned } = harness({
    quarantine: { check: () => { throw new QuarantineUnavailable("the booru's quarantine document has not been read yet"); } },
  });
  const res = await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "2");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(presigned.length, 0);
  assert.ok(logs.some((l) => /QUARANTINE UNREADABLE/.test(l)));
  assert.equal(signals.health().checks.find((c) => c.id === "quarantine-unavailable").level, "red");
  // A visible post (the booru decides it, and hides quarantined posts itself)
  // and a no-cookie refusal never consult the quarantine.
  assert.equal((await call(handler, `${VISIBLE}.png`, { headers: EDGE, cookies: { [`fourier_pub_${PUB}`]: "1" } })).statusCode, 200);
  assert.equal((await call(handler, `${RESTRICTED}.jpg`, { headers: EDGE })).statusCode, 404);
});

// -- a flagged Matrix post: no reviewer's opening (closed 2026-10-15) --------
//
// Gate 3 is on and Matrix review is in sampling's jail panel, which reads R2
// itself. Nothing needs this door to open a flagged Matrix file, so it does
// not, even to a reader whose own booru session sees the post.

test("a flagged Matrix file is REFUSED at the booru door even to a reader whose own session sees its post -- original and variants", async () => {
  // Every input the closed opening read still answers yes, recorded, so a
  // branch that consulted them would admit this reader and be caught.
  const opening = [];
  const { handler, presigned, signals, logs } = harness({
    isMatrixImage: async () => true,
    visibility: {
      sees: async (md5, viewer) => !!viewer && viewer.sessionCookie === "ADMIN%2Bsess" && md5 === FLAGGED_MXC,
      seesNonMatrix: async () => false,
      readerSees: async (md5, viewer) => { opening.push({ md5, viewer }); return !!viewer && viewer.sessionCookie === "ADMIN%2Bsess"; },
    },
    quarantine: {
      check: ({ md5 }) => (md5 === FLAGGED_MXC ? "refuse" : "allow"),
      reviewable: (md5) => { opening.push({ md5 }); return md5 === FLAGGED_MXC; },
    },
  });
  for (const query of [{}, { w: "180", h: "180" }, { w: "720" }, { dl: "1" }]) {
    const res = await call(handler, `${FLAGGED_MXC}.png`, { query, headers: { ...EDGE, ...ADMIN_COOKIE } });
    assert.equal(res.statusCode, 404, JSON.stringify(query));
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(!leaksCredential(res));
  }
  assert.equal(presigned.length, 0, "nothing was even signed");
  assert.deepEqual(opening, [], "the closed opening's questions are never asked");
  assert.equal(signals.counts().matrix_refused, 4);
  assert.ok(logs.every((l) => !/reviewer/.test(l)), logs.join("\n"));
});
