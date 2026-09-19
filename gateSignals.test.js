"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { GateSignals, WINDOW_MS } = require("./gateSignals");

// The lamp: a signed-in reader refused turns the gate's health red; the
// counts age out after ten minutes; a fresh gate is green.

test("a fresh gate is green with three clear checks", () => {
  const g = new GateSignals(() => 1_000_000);
  const h = g.health();
  assert.equal(h.level, "ok");
  assert.deepEqual(h.checks.map((c) => c.level), ["green", "green", "green"]);
});

test("one refusal to a session cookie is RED, and the check names it", () => {
  const g = new GateSignals(() => 1_000_000);
  g.sessionRefused(403, "/media/41chan.net/abc");
  const h = g.health();
  assert.equal(h.level, "red");
  const c = h.checks.find((x) => x.id === "session-refusals");
  assert.equal(c.level, "red");
  assert.match(c.detail, /1 refusal/);
  assert.match(c.detail, /403 \/media\/41chan\.net\/abc/);
});

test("a stale session with no refresh token is AMBER, a refused refresh is RED", () => {
  const g = new GateSignals(() => 1_000_000);
  g.staleUnrenewable("@u:41chan.net");
  assert.equal(g.health().level, "amber");
  g.refreshFailed("invalid_grant");
  assert.equal(g.health().level, "red");
});

test("counts age out after the window", () => {
  let t = 1_000_000;
  const g = new GateSignals(() => t);
  g.sessionRefused(401);
  g.sessionRefused(403);
  assert.equal(g.counts().session_refusals, 2);
  t += WINDOW_MS + 1;
  assert.equal(g.counts().session_refusals, 0);
  assert.equal(g.health().level, "ok");
});

test("the ring is bounded, so a flood cannot grow memory", () => {
  const g = new GateSignals(() => 1_000_000);
  for (let i = 0; i < 6000; i++) g.sessionRefused(401);
  assert.ok(g.rings.session_refusals.length <= 5000);
});
