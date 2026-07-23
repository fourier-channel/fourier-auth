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
