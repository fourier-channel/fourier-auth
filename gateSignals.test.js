"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { GateSignals, WINDOW_MS } = require("./gateSignals");

// The lamp: a signed-in reader refused turns the gate's health red; the
// counts age out after ten minutes; a fresh gate is green.

test("a fresh gate is green with seven clear checks", () => {
  const g = new GateSignals(() => 1_000_000);
  const h = g.health();
  assert.equal(h.level, "ok");
  assert.deepEqual(h.checks.map((c) => c.level), ["green", "green", "green", "green", "green", "green", "green"]);
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

// -- leak audit 2026-10-01 ---------------------------------------------------

test("F-G1: the booru being unreachable is RED; a hidden md5 is counted, never flagged", () => {
  const down = new GateSignals(() => 1_000_000);
  down.booruUnavailable("booru posts.json answered 502");
  assert.equal(down.health().level, "red");
  assert.equal(down.health().checks.find((x) => x.id === "booru-visibility").level, "red");

  const scan = new GateSignals(() => 1_000_000);
  for (let i = 0; i < 30; i++) scan.booruHidden(`/booru/${i}`);
  const h = scan.health();
  assert.equal(h.level, "ok");
  assert.equal(h.counts.booru_hidden, 30);
});

test("F-G5: without detail, no check carries a last-seen mxc id or Matrix user id", () => {
  const g = new GateSignals(() => 1_000_000);
  g.sessionRefused(403, "/media/41chan.net/SECRETMEDIAID", "no-rooms");
  g.sessionRefused(403, "/media/41chan.net/SECRETMEDIAID2", "unplaced");
  g.sessionRefused(403, "/media/41chan.net/SECRETMEDIAID3", "not-member");
  g.staleUnrenewable("token past its life (@alice:41chan.net)");
  g.refreshFailed("refresh failed for @bob:41chan.net: invalid_grant");
  g.booruUnavailable("connect ECONNREFUSED 172.18.0.5:3000");
  g.booruHidden("/booru/0123456789abcdef0123456789abcdef");
  const pub = JSON.stringify(g.health(undefined, { detail: false }));
  for (const leak of ["SECRETMEDIAID", "@alice", "@bob", "172.18.0.5", "0123456789abcdef", "last:"]) {
    assert.ok(!pub.includes(leak), `public health leaks ${leak}`);
  }
  // Levels and counts survive: the lamp still works for the public probe.
  const h = g.health(undefined, { detail: false });
  assert.equal(h.level, "red");
  assert.equal(h.counts.session_refusals, 1);
  // And the private view keeps everything.
  const priv = JSON.stringify(g.health());
  for (const kept of ["SECRETMEDIAID", "@alice", "@bob"]) assert.ok(priv.includes(kept), kept);
});
