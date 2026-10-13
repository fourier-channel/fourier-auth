"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { originalRelease, releaseModeFromEnv } = require("./release");

// THE ONE RELEASE MODE (2026-10-13). MEDIA_ORIGINAL_RELEASE used to accept
// "proxy" -- stream originals through this host. The streaming code was
// removed on the 2026-08-15 ruling and the switch was left behind, where
// setting it made every native original load 404. The operator: "There should
// be no fallback." This file used to test a copy of the old branch predicate
// written inside the test itself (defaulting to "proxy", unlike index.js), so
// it proved nothing about the service; it now tests the function index.js
// calls at boot.

test("unset or redirect is the mode", () => {
  assert.equal(releaseModeFromEnv({}), "redirect");
  assert.equal(releaseModeFromEnv({ MEDIA_ORIGINAL_RELEASE: "" }), "redirect");
  assert.equal(releaseModeFromEnv({ MEDIA_ORIGINAL_RELEASE: "redirect" }), "redirect");
  assert.equal(releaseModeFromEnv({ MEDIA_ORIGINAL_RELEASE: " REDIRECT " }), "redirect");
});

test("proxy, or anything else, refuses to start and names the fix", () => {
  for (const v of ["proxy", "PROXY", "yes", "1", "stream"]) {
    assert.throws(() => releaseModeFromEnv({ MEDIA_ORIGINAL_RELEASE: v }),
      /not a release mode.*Remove the variable/, `MEDIA_ORIGINAL_RELEASE=${v}`);
  }
});

// Kept from the old file, because it is the one invariant here with teeth:
// a fetch() that follows a cross-origin 302 has its Origin tainted to "null"
// and R2's CORS allow-list cannot match it, so Technetium's originals break
// if a cors fetch is ever redirected. See release.js.
test("a cors fetch, and a non-browser caller, get the JSON envelope; a native load the redirect", () => {
  assert.equal(originalRelease({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }), "json");
  assert.equal(originalRelease({}), "json");
  assert.equal(originalRelease({ "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" }), "redirect");
});
