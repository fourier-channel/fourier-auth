"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { makeTokenSource, REFRESH_AHEAD_MS } = require("./tokenRefresh");

// The session lived 24 hours; its Matrix token lived five minutes; nothing
// refreshed it. These pin the one place a token is handed out for use.

function harness(session, opts = {}) {
  const store = new Map([["sid1", { ...session }]]);
  const grants = [];
  let clock = 1_000_000_000_000;
  const logs = { warn: [], error: [] };
  const src = makeTokenSource({
    getSession: async (sid) => store.get(sid) || null,
    saveSession: async (sid, s) => { store.set(sid, s); },
    refreshGrant: async (rt) => {
      grants.push(rt);
      if (opts.refuse) throw new Error("invalid_grant");
      await new Promise((r) => setTimeout(r, 5));
      return { access_token: `at-${grants.length}`, refresh_token: `rt-${grants.length}`, expires_in: 300 };
    },
    now: () => clock,
    log: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
  });
  return { src, store, grants, logs, tick: (ms) => { clock += ms; }, at: () => clock };
}

test("a token with life left is handed out as it is, and nothing is asked of MAS", async () => {
  const h = harness({ matrixToken: "at-0", refreshToken: "rt-0", tokenExpiresAt: 1_000_000_000_000 + 200_000 });
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-0");
  assert.deepEqual(h.grants, []);
});

test("a token within a minute of expiry is refreshed first, and the rotated pair is saved", async () => {
  const h = harness({ matrixToken: "at-0", refreshToken: "rt-0", tokenExpiresAt: 1_000_000_000_000 + REFRESH_AHEAD_MS - 1 });
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-1");
  assert.deepEqual(h.grants, ["rt-0"]);
  const saved = h.store.get("sid1");
  assert.equal(saved.refreshToken, "rt-1");
  assert.equal(saved.tokenExpiresAt, h.at() + 300_000);
  // And the next call, seconds later, asks nothing.
  h.tick(5_000);
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-1");
  assert.deepEqual(h.grants, ["rt-0"]);
});

test("ten concurrent callers on one stale session cause ONE refresh -- MAS rotates refresh tokens", async () => {
  const h = harness({ matrixToken: "at-0", refreshToken: "rt-0", tokenExpiresAt: 1_000_000_000_000 });
  const s = h.store.get("sid1");
  const tokens = await Promise.all(Array.from({ length: 10 }, () => h.src.freshToken("sid1", s)));
  assert.deepEqual(h.grants, ["rt-0"]);
  assert.ok(tokens.every((t) => t === "at-1"), tokens.join(","));
});

test("a session minted without a refresh token is handed out as it is, and said so", async () => {
  const h = harness({ matrixToken: "at-0", matrixUserId: "@u:x", tokenExpiresAt: 1_000_000_000_000 });
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-0");
  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /no refresh token/);
});

test("a session with no known expiry (minted before this existed) is never refreshed", async () => {
  const h = harness({ matrixToken: "at-0", refreshToken: "rt-0" });
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-0");
  assert.deepEqual(h.grants, []);
});

test("a refused refresh hands back the old token, logs loudly, and does not wedge later calls", async () => {
  const h = harness({ matrixToken: "at-0", matrixUserId: "@u:x", refreshToken: "rt-0", tokenExpiresAt: 1_000_000_000_000 }, { refuse: true });
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-0");
  assert.equal(h.logs.error.length, 1);
  assert.match(h.logs.error[0], /refresh failed/);
  // The lock is released: a second call tries again rather than waiting forever.
  assert.equal(await h.src.freshToken("sid1", h.store.get("sid1")), "at-0");
  assert.equal(h.grants.length, 2);
});

test("a missing session yields no token", async () => {
  const h = harness({});
  assert.equal(await h.src.freshToken("sid1", null), null);
});
