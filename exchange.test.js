"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { exchangeCorsHeaders, bearerToken } = require("./exchange");

test("only a listed origin gets credentialed CORS, echoed exactly", () => {
  const allowed = ["https://tc.41chan.net", "http://localhost:5173"];
  const h = exchangeCorsHeaders("https://tc.41chan.net", allowed);
  assert.equal(h["Access-Control-Allow-Origin"], "https://tc.41chan.net");
  assert.equal(h["Access-Control-Allow-Credentials"], "true");
  assert.equal(h["Vary"], "Origin");
  assert.equal(exchangeCorsHeaders("https://evil.example", allowed), null);
  assert.equal(exchangeCorsHeaders(undefined, allowed), null);
  assert.equal(exchangeCorsHeaders("https://tc.41chan.net", []), null);
});

test("bearerToken accepts only a Bearer scheme", () => {
  assert.equal(bearerToken("Bearer syt_abc"), "syt_abc");
  assert.equal(bearerToken("bearer syt_abc"), "syt_abc");
  assert.equal(bearerToken("Basic xyz"), null);
  assert.equal(bearerToken(""), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("Bearer"), null);
});
