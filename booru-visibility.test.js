"use strict";

// The booru door's new question (leak audit F-G1, 2026-10-01): is there a
// post for this md5 that this reader may see? Proven here without a booru:
// what is asked, how the answer is read, the batching that keeps a page of
// thumbnails to one query, the caching, and that "could not ask" is never
// rendered as "yes".

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBooruVisibility, booruPostsClient, BooruUnavailable, MAX_BATCH } = require("./booru-visibility");

const md5 = (i) => i.toString(16).padStart(32, "0");

function fakes(over = {}) {
  const cache = new Map();
  const calls = [];
  const deps = {
    fetchVisible: async (md5s, viewer) => { calls.push({ md5s: [...md5s], viewer }); return new Set(); },
    cacheGet: async (k) => (cache.has(k) ? cache.get(k) : null),
    cacheSet: async (k, v, ttl) => { cache.set(k, { ...v, ttl }); },
    hashKey: (s) => "h" + s.length,
    ...over,
  };
  return { deps, cache, calls };
}

// -- the client: what the booru is asked and how its answer is read ----------

function fakeAxios(answer) {
  const seen = [];
  return {
    seen,
    get: async (url, cfg) => { seen.push({ url, cfg }); return typeof answer === "function" ? answer(url, cfg) : answer; },
  };
}

test("asks posts.json for the md5s, as an anonymous reader, for md5 and is_deleted only", async () => {
  const ax = fakeAxios({ status: 200, data: [] });
  await booruPostsClient({ axios: ax, baseUrl: "http://danbooru:3000/" })([md5(1), md5(2)]);
  const { url, cfg } = ax.seen[0];
  assert.equal(url, "http://danbooru:3000/posts.json");
  assert.equal(cfg.params.tags, `md5:${md5(1)},${md5(2)}`);
  assert.equal(cfg.params.only, "md5,is_deleted");
  assert.equal(cfg.params.limit, 2);
  assert.equal(cfg.headers.Cookie, undefined, "anonymous carries no cookie");
  assert.equal(cfg.maxRedirects, 0);
});

test("a row counts only when it hands the md5 back and is not deleted", async () => {
  // The booru strips md5 from a post the viewer may not see the media of
  // (PostPolicy#can_see_media?), so a row without one is not a yes.
  const ax = fakeAxios({ status: 200, data: [
    { md5: md5(1), is_deleted: false },
    { id: 9, is_deleted: false },          // md5 withheld by the booru
    { md5: md5(3), is_deleted: true },     // an admin-visible deleted post
    { md5: md5(4) },                       // is_deleted absent: not deleted
    { md5: md5(99), is_deleted: false },   // not asked for
  ] });
  const client = booruPostsClient({ axios: ax, baseUrl: "http://b" });
  const seen = await client([md5(1), md5(2), md5(3), md5(4)]);
  assert.deepEqual([...seen].sort(), [md5(1), md5(4)]);
  // Asked AS a reader, a deleted post the booru hands the md5 of is theirs to
  // see: an admin reviewing it, or its uploader appealing.
  const asAdmin = await client([md5(1), md5(2), md5(3), md5(4)], { sessionCookie: "admin" });
  assert.deepEqual([...asAdmin].sort(), [md5(1), md5(3), md5(4)]);
});

test("asking AS a reader forwards only their booru session, and their address", async () => {
  const ax = fakeAxios({ status: 200, data: [] });
  await booruPostsClient({ axios: ax, baseUrl: "http://b" })([md5(1)], { sessionCookie: "abc%3D", clientIp: "203.0.113.9" });
  assert.equal(ax.seen[0].cfg.headers.Cookie, "_danbooru2_session=abc%3D");
  assert.equal(ax.seen[0].cfg.headers["X-Forwarded-For"], "203.0.113.9");
});

test("anything but a 200 with a list is 'could not ask', never an empty answer", async () => {
  for (const answer of [{ status: 502, data: "<html>" }, { status: 302, data: "" }, { status: 200, data: { error: "x" } }]) {
    const client = booruPostsClient({ axios: fakeAxios(answer), baseUrl: "http://b" });
    await assert.rejects(() => client([md5(1)]), Error);
  }
});

test("a batch beyond the booru's 20-row ceiling is refused, never silently truncated", async () => {
  assert.equal(MAX_BATCH, 20, "restricted_browsing_per_page is 20 for anonymous readers");
  const client = booruPostsClient({ axios: fakeAxios({ status: 200, data: [] }), baseUrl: "http://b" });
  await assert.rejects(() => client(Array.from({ length: 21 }, (_, i) => md5(i))), /20-row ceiling/);
});

// -- the decision ---------------------------------------------------------------

test("a jailed, deleted or never-posted md5 is refused; a visible one is allowed", async () => {
  const visible = new Set([md5(1)]);
  const { deps } = fakes({ fetchVisible: async (m) => new Set(m.filter((x) => visible.has(x))) });
  const v = createBooruVisibility(deps, { windowMs: 0 });
  assert.equal(await v.sees(md5(1)), true);
  assert.equal(await v.sees(md5(2)), false);
});

test("a wall of thumbnails is ONE query per 20, each md5 asked once", async () => {
  const { deps, calls } = fakes({ fetchVisible: async (m) => { calls.push(m); return new Set(m); } });
  const v = createBooruVisibility(deps, { windowMs: 5 });
  // 45 thumbnails, each asked for twice (an <img> and its srcset, say).
  const asks = [];
  for (let i = 0; i < 45; i++) asks.push(v.sees(md5(i)), v.sees(md5(i)));
  const out = await Promise.all(asks);
  assert.ok(out.every(Boolean));
  assert.equal(calls.length, 3, "45 md5s -> batches of 20, 20, 5");
  assert.deepEqual(calls.map((c) => c.length), [20, 20, 5]);
  assert.equal(v.pendingCount(), 0);
});

test("answers are cached: positive longer than negative, and a cached answer costs no query", async () => {
  const { deps, cache, calls } = fakes({ fetchVisible: async (m) => { calls.push(m); return new Set([md5(1)]); } });
  const v = createBooruVisibility(deps, { windowMs: 0 });
  await Promise.all([v.sees(md5(1)), v.sees(md5(2))]);
  await new Promise((r) => setImmediate(r));
  const pos = cache.get(`boorusees:${md5(1)}`), neg = cache.get(`boorusees:${md5(2)}`);
  assert.equal(pos.v, true);
  assert.equal(neg.v, false);
  assert.ok(pos.ttl > neg.ttl, "a just-jailed image is the staleness that matters; a no expires faster");
  assert.ok(pos.ttl <= 120, "the jail window is bounded");
  await v.sees(md5(1));
  assert.equal(calls.length, 1);
});

test("the booru unreachable is BooruUnavailable for every waiting ask, and nothing is cached", async () => {
  const { deps, cache } = fakes({ fetchVisible: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } });
  const v = createBooruVisibility(deps, { windowMs: 1 });
  const results = await Promise.allSettled([v.sees(md5(1)), v.sees(md5(2))]);
  for (const r of results) {
    assert.equal(r.status, "rejected");
    assert.ok(r.reason instanceof BooruUnavailable, "fail closed, and say why");
  }
  assert.equal(cache.size, 0, "an outage must not be remembered as an answer");
  assert.equal(v.pendingCount(), 0);
});

test("a reader is asked as themselves only when anonymous is refused", async () => {
  // Anonymous sees md5(1). The admin (by their booru session) also sees md5(2),
  // a deleted post they are reviewing.
  const { deps, calls } = fakes({
    fetchVisible: async (m, viewer) => {
      calls.push({ m, viewer });
      const sees = viewer ? new Set([md5(1), md5(2)]) : new Set([md5(1)]);
      return new Set(m.filter((x) => sees.has(x)));
    },
  });
  const v = createBooruVisibility(deps, { windowMs: 0 });
  const admin = { sessionCookie: "admin-session", clientIp: "203.0.113.9" };
  assert.equal(await v.sees(md5(1), admin), true);
  assert.equal(calls.length, 1, "an anonymous yes never asks as the reader");
  assert.equal(calls[0].viewer, null);
  assert.equal(await v.sees(md5(2), admin), true);
  assert.equal(calls[2].viewer, admin, "the anonymous no was followed by an ask as the reader");
  assert.equal(await v.sees(md5(2)), false, "and that answer is never shared with anyone else");
});

test("a reader's answer is cached under their session's hash, never the session itself", async () => {
  const { deps, cache } = fakes({ fetchVisible: async (m, viewer) => (viewer ? new Set(m) : new Set()) });
  const v = createBooruVisibility(deps, { windowMs: 0 });
  await v.sees(md5(7), { sessionCookie: "the-real-cookie-value" });
  await new Promise((r) => setImmediate(r));
  const keys = [...cache.keys()].join(" ");
  assert.ok(!keys.includes("the-real-cookie-value"), keys);
  assert.ok(cache.has(`boorusees:v${deps.hashKey("the-real-cookie-value")}:${md5(7)}`), keys);
});
