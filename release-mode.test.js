"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { originalRelease } = require("./release");

// Which release path a request takes, as a pure decision, so the branch in
// index.js can be reasoned about without standing up Synapse and R2.
//
// The rule under test: in "proxy" mode a NATIVE load is streamed (clean URL);
// a cors fetch() still gets the JSON envelope. That second half is not a
// preference -- a fetch that follows a cross-origin 302 has its Origin tainted
// to "null" and R2's CORS allow-list cannot match it, so Technetium's original
// path breaks if it is ever redirected. See release.js.
function takesRedirectBranch(mode, headers) {
  return !(mode === "proxy" && originalRelease(headers) === "redirect");
}

const IMG = { "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" };
const NAV = { "sec-fetch-mode": "navigate" };
const CORS_FETCH = { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };
const CURL = {};

test("proxy mode: an <img> load is streamed, not redirected", () => {
  assert.equal(takesRedirectBranch("proxy", IMG), false);
  assert.equal(takesRedirectBranch("proxy", NAV), false);
});

test("proxy mode: a cors fetch STILL gets the JSON envelope", () => {
  // The safety invariant. If this ever flips, Technetium's originals go blank
  // with a 200 and a CORS error, which is a maddening thing to debug.
  assert.equal(originalRelease(CORS_FETCH), "json");
  assert.equal(takesRedirectBranch("proxy", CORS_FETCH), true);
});

test("proxy mode: non-browser callers keep the JSON envelope", () => {
  assert.equal(originalRelease(CURL), "json");
  assert.equal(takesRedirectBranch("proxy", CURL), true);
});

test("redirect mode restores the old behaviour exactly", () => {
  for (const h of [IMG, NAV, CORS_FETCH, CURL]) {
    assert.equal(takesRedirectBranch("redirect", h), true,
      "redirect mode must reach the presign branch for every caller");
  }
});

test("the mode parser defaults to proxy and only accepts the one opt-out", () => {
  const parse = (v) => (String(v || "proxy").toLowerCase() === "redirect" ? "redirect" : "proxy");
  assert.equal(parse(undefined), "proxy");
  assert.equal(parse(""), "proxy");
  assert.equal(parse("REDIRECT"), "redirect");
  assert.equal(parse("redirect"), "redirect");
  // Anything unrecognised must fail toward the safe URL, not toward the
  // credential-bearing one.
  assert.equal(parse("yes"), "proxy");
  assert.equal(parse("1"), "proxy");
});
