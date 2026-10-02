"use strict";

// A published page's grant (operator ruling 2026-10-02): what the gate asks
// sampling, how the answer is read, and the limits -- 60 s at most, 8
// publications at most, closed when sampling cannot be asked.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicationGrants, samplingPublicationClient, pubHashes, shownMd5s, PublicationsUnavailable, MAX_PUBS, TTL_SECONDS } = require("./publication-grants");

const H = (c) => c.repeat(32);
const M = (i) => i.toString(16).padStart(32, "0");

function media(md5, over = {}) {
  return { media: { md5_hex: md5, withheld: false, src: `/fourier/booru/${md5}.png`, ...over } };
}

test("a page shows an md5 only with a digest, not withheld, and a URL the page links", () => {
  const data = { posts: [
    media(M(1)),                                                   // shown
    media("", { withheld: true, src: null }),                       // jailed: redacted by sampling
    media(M(3), { withheld: true }),                                 // withheld, not redacted: still refused
    media(M(4), { src: null }),                                      // not posted yet: placeholder, no URL
    { no: 5 },                                                       // text only
    media("not-an-md5"),
  ] };
  assert.deepEqual([...shownMd5s(data)], [M(1)]);
});

test("the cookie names: well formed, in order, de-duplicated, at most 8", () => {
  const cookies = { fourier_session: "x", [`fourier_pub_${H("a")}`]: "1", fourier_pub_XYZ: "1", [`fourier_pub_${H("A")}`]: "1" };
  for (let i = 0; i < 12; i++) cookies[`fourier_pub_${M(i + 100)}`] = "1";
  const hs = pubHashes(cookies);
  assert.equal(MAX_PUBS, 8);
  assert.equal(hs.length, 8, "the cap");
  assert.equal(hs[0], H("a"), "order kept: the Worker puts the page being read first");
  assert.ok(!hs.includes(H("A")), "uppercase is not a hash newHash makes");
  assert.deepEqual(pubHashes(undefined), []);
});

function fakeAxios(byHash) {
  const asked = [];
  return { asked, get: async (url) => { asked.push(url); const h = /\/p\/([0-9a-f]{32})\/data$/.exec(url)[1]; return byHash[h] ?? { status: 404, data: "<html>" }; } };
}

test("asks sampling for the page's data; 404 is a dead page, not an outage", async () => {
  const ax = fakeAxios({ [H("a")]: { status: 200, data: { posts: [media(M(1))] } } });
  const f = samplingPublicationClient({ axios: ax, baseUrl: "http://172.18.0.1:5181/" });
  assert.deepEqual(await f(H("a")), { live: true, md5s: [M(1)] });
  assert.equal(ax.asked[0], `http://172.18.0.1:5181/p/${H("a")}/data`);
  assert.deepEqual(await f(H("b")), { live: false, md5s: [] });
  for (const bad of [{ status: 502, data: "" }, { status: 200, data: "<html>" }, { status: 301, data: "" }]) {
    await assert.rejects(() => samplingPublicationClient({ axios: fakeAxios({ [H("c")]: bad }), baseUrl: "http://s" })(H("c")));
  }
});

function harness(pages) {
  const cache = new Map();
  const calls = [];
  const deps = {
    fetchPublication: async (h) => { calls.push(h); const p = pages[h]; if (p instanceof Error) throw p; return p ?? { live: false, md5s: [] }; },
    cacheGet: async (k) => (cache.has(k) ? cache.get(k).v : null),
    cacheSet: async (k, v, ttl) => { cache.set(k, { v, ttl }); },
  };
  return { g: createPublicationGrants(deps), cache, calls };
}

test("grants an md5 a live page shows -- a restricted-tag image included -- and nothing else", async () => {
  const { g } = harness({ [H("a")]: { live: true, md5s: [M(1), M(2)] } });
  assert.equal(await g.grants(M(1), [H("a")]), true);
  assert.equal(await g.grants(M(9), [H("a")]), false, "not on the page");
  assert.equal(await g.grants(M(1), [H("b")]), false, "a page that does not exist");
});

test("an expired or unpublished page grants nothing, and the answer lives 60 s at most", async () => {
  const { g, cache } = harness({ [H("a")]: { live: false, md5s: [] } });
  assert.equal(await g.grants(M(1), [H("a")]), false);
  assert.equal(TTL_SECONDS, 60);
  assert.ok(cache.get(`pubgrant:${H("a")}`).ttl <= 60);
  // A caller cannot stretch it either.
  const long = createPublicationGrants({ fetchPublication: async () => ({ live: true, md5s: [] }), cacheGet: async () => null,
    cacheSet: async (k, v, ttl) => assert.ok(ttl <= 60) }, { ttlSeconds: 3600 });
  await long.grants(M(1), [H("a")]);
});

test("a page's answer is cached and coalesced: a wall of thumbnails asks once", async () => {
  const { g, calls } = harness({ [H("a")]: { live: true, md5s: Array.from({ length: 40 }, (_, i) => M(i)) } });
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => g.grants(M(i), [H("a")])));
  assert.ok(out.every(Boolean));
  assert.equal(calls.length, 1);
});

test("at most 8 publications are asked, however many cookies arrive", async () => {
  const pages = {};
  const hashes = Array.from({ length: 12 }, (_, i) => M(500 + i));
  for (const h of hashes) pages[h] = { live: true, md5s: [] };
  pages[hashes[10]] = { live: true, md5s: [M(1)] };
  const { g, calls } = harness(pages);
  assert.equal(await g.grants(M(1), hashes), false, "the 11th is never consulted");
  assert.equal(calls.length, 8);
});

test("sampling unreachable: closed, and said so -- unless another page already grants it", async () => {
  const boom = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const { g, cache } = harness({ [H("a")]: boom, [H("b")]: { live: true, md5s: [M(1)] } });
  await assert.rejects(() => g.grants(M(1), [H("a")]), PublicationsUnavailable);
  assert.equal(cache.has(`pubgrant:${H("a")}`), false, "an outage is not remembered as an answer");
  assert.equal(await g.grants(M(1), [H("a"), H("b")]), true);
  await assert.rejects(() => g.grants(M(2), [H("a"), H("b")]), PublicationsUnavailable);
});
