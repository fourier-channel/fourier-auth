"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { originalRelease } = require("./release");

test("chanbooru inline <img> load -> redirect (observed: dest=image, mode=no-cors)", () => {
  assert.equal(
    originalRelease({ "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" }),
    "redirect",
  );
});

test("chanbooru view-original / download link navigation -> redirect", () => {
  assert.equal(
    originalRelease({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }),
    "redirect",
  );
});

test("SAFETY: Technetium cors fetch() -> json, never redirect (dest=empty, mode=cors)", () => {
  assert.equal(
    originalRelease({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }),
    "json",
  );
});

test("SAFETY: a cors request is never redirected even if dest looks native", () => {
  assert.equal(
    originalRelease({ "sec-fetch-dest": "image", "sec-fetch-mode": "cors" }),
    "json",
  );
});

test("absent Sec-Fetch-* headers (curl, old browsers) -> json, the safe default", () => {
  assert.equal(originalRelease({}), "json");
  assert.equal(originalRelease(null), "json");
});

test("iframe embed load -> redirect", () => {
  assert.equal(originalRelease({ "sec-fetch-dest": "iframe" }), "redirect");
});

// THE TOKENLESS RELEASE's flag (operator ruling 2026-11-01; media-route.js).
// The edge Worker cannot tell a dead session from a live one, so the gate says
// when an allow was given to nobody: { url, anonymous: true }, kept 60 s at the
// edge instead of 150. Only the edge's envelope carries it; a direct caller's
// answer is unchanged.
const { sendRelease } = require("./release");
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, location: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; return this; },
    redirect(c, l) { this.statusCode = c; this.location = l; return this; },
  };
}
const CORS_FETCH = { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

test("sendRelease: an anonymous release to the edge says so; a token holder's does not", () => {
  const anon = fakeRes();
  sendRelease({ headers: CORS_FETCH }, anon, "https://r2/x?sig", { edge: true, anonymous: true });
  assert.deepEqual(anon.body, { url: "https://r2/x?sig", anonymous: true });
  const held = fakeRes();
  sendRelease({ headers: CORS_FETCH }, held, "https://r2/x?sig", { edge: true });
  assert.deepEqual(held.body, { url: "https://r2/x?sig" });
});

test("sendRelease: a direct caller's answer is unchanged by the flag -- no URL, no new field", () => {
  const res = fakeRes();
  sendRelease({ headers: CORS_FETCH }, res, null, { edge: false, anonymous: true });
  assert.deepEqual(Object.keys(res.body).sort(), ["allowed", "error", "released"]);
  assert.equal(res.headers["cache-control"], "no-store");
});
