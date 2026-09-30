"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { GateSignals, WINDOW_MS } = require("./gateSignals");

// The lamp: a signed-in reader refused turns the gate's health red; the
// counts age out after ten minutes; a fresh gate is green.

test("a fresh gate is green with five clear checks", () => {
  const g = new GateSignals(() => 1_000_000);
  const h = g.health();
  assert.equal(h.level, "ok");
  assert.deepEqual(h.checks.map((c) => c.level), ["green", "green", "green", "green", "green"]);
});

test("a refusal is sorted by why: a dead session is RED, an image in no room AMBER, a non-member GREEN", () => {
  const dead = new GateSignals(() => 1_000_000);
  dead.sessionRefused(403, "/media/41chan.net/a", "no-rooms");
  assert.equal(dead.health().level, "red");
  assert.match(dead.health().checks.find((x) => x.id === "session-refusals").detail, /no-rooms/);

  const rejected = new GateSignals(() => 1_000_000);
  rejected.sessionRefused(403, "/media/41chan.net/a", "token-rejected");
  assert.equal(rejected.health().level, "red");

  // The 2026-09-28 case: an image its poster deleted in June.
  const deleted = new GateSignals(() => 1_000_000);
  deleted.sessionRefused(403, "/media/41chan.net/vhhcl", "unplaced");
  const hd = deleted.health();
  assert.equal(hd.level, "amber");
  assert.equal(hd.checks.find((x) => x.id === "session-refusals").level, "green");
  const unplaced = hd.checks.find((x) => x.id === "unplaced-media");
  assert.equal(unplaced.level, "amber");
  assert.match(unplaced.detail, /1 in 10 min/);
  assert.match(unplaced.detail, /\/media\/41chan\.net\/vhhcl/);

  const outsider = new GateSignals(() => 1_000_000);
  outsider.sessionRefused(403, "/media/41chan.net/b", "not-member");
  const ho = outsider.health();
  assert.equal(ho.level, "ok");
  assert.match(ho.checks.find((x) => x.id === "member-refusals").detail, /^1 in 10 min/);
});

test("a refusal with no reason is RED, and the check names it -- an unexplained refusal is what the lamp is for", () => {
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
