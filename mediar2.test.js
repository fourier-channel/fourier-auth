"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { localOriginalKey, remoteOriginalKey, thumbnailPrefix,
        parseThumbName, pickThumbnail, resolveR2Key } = require("./mediar2");

// Keys are checked against REAL objects listed from the bucket on 2026-08-15,
// not against what the layout is believed to be. A key that is wrong by one
// shard produces a 404 that looks exactly like "R2 does not have it", and the
// fallback then quietly streams every byte through the host -- the failure
// this whole change exists to remove, hidden by its own safety net.

test("local original key matches a real object", () => {
  assert.equal(localOriginalKey("dDqkdaQqsrSCxDyreanu"), "local_content/dD/qk/daQqsrSCxDyreanu");
  // observed: local_content/AG/TQ/dDqkdaQqsrSCxDyreanu is a DIFFERENT media id
  assert.equal(localOriginalKey("AGTQdDqkdaQqsrSCxDyreanu"), "local_content/AG/TQ/dDqkdaQqsrSCxDyreanu");
});

test("remote original key carries the server between prefix and shards", () => {
  assert.equal(remoteOriginalKey("100oj.com", "nEbZWucSHwUlioSKGaLMDJvZ"),
    "remote_content/100oj.com/nE/bZ/WucSHwUlioSKGaLMDJvZ");
});

test("thumbnail prefixes differ by more than the leading segment", () => {
  // local_thumbnails vs remote_thumbnail -- singular on one, plural on the
  // other. Synapse's own inconsistency, and a very easy typo to ship.
  assert.equal(thumbnailPrefix(null, "AGTQdDqkdaQqsrSCxDyreanu", true),
    "local_thumbnails/AG/TQ/dDqkdaQqsrSCxDyreanu/");
  assert.equal(thumbnailPrefix("100oj.com", "nEbZWucSHwUlioSKGaLMDJvZ", false),
    "remote_thumbnail/100oj.com/nE/bZ/WucSHwUlioSKGaLMDJvZ/");
});

test("thumbnail names parse, including non-square rendered sizes", () => {
  const t = parseThumbName("local_thumbnails/AG/TQ/x/164-240-image-jpeg-scale");
  assert.deepEqual({ w: t.width, h: t.height, type: t.type, method: t.method },
    { w: 164, h: 240, type: "image-jpeg", method: "scale" });
  // The reason keys cannot be derived: 164x240 came from a square request.
  assert.notEqual(t.width, t.height);
});

test("anything unrecognised in the prefix is ignored, not mis-chosen", () => {
  assert.equal(parseThumbName("local_thumbnails/AG/TQ/x/notathumbnail"), null);
  assert.equal(pickThumbnail(["local_thumbnails/AG/TQ/x/junk"], 240, "scale"), null);
});

const NAMES = [
  "local_thumbnails/AG/TQ/x/32-32-image-jpeg-crop",
  "local_thumbnails/AG/TQ/x/164-240-image-jpeg-scale",
  "local_thumbnails/AG/TQ/x/800-600-image-jpeg-scale",
];

test("picks the smallest rendition at least as large as asked", () => {
  assert.match(pickThumbnail(NAMES, 240, "scale").key, /164-240/);
  assert.match(pickThumbnail(NAMES, 700, "scale").key, /800-600/);
});

test("never upscales past what is stored -- takes the largest instead", () => {
  assert.match(pickThumbnail(NAMES, 5000, "scale").key, /800-600/);
});

test("prefers the requested method but does not fail without it", () => {
  assert.match(pickThumbnail(NAMES, 32, "crop").key, /32-32-image-jpeg-crop/);
  const scaleOnly = NAMES.filter((n) => n.endsWith("scale"));
  assert.ok(pickThumbnail(scaleOnly, 32, "crop"), "must still answer when no crop exists");
});

test("an empty prefix resolves to null so the caller falls back to streaming", async () => {
  const s3 = { send: async () => ({ Contents: [] }) };
  assert.equal(await resolveR2Key(s3, "b", { serverName: "x", mediaId: "abcdef", isLocal: true, thumbSize: 240 }), null);
});

test("originals need no listing at all", async () => {
  let listed = false;
  const s3 = { send: async () => { listed = true; return { Contents: [] }; } };
  const key = await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: "AGTQabc", isLocal: true });
  assert.equal(key, "local_content/AG/TQ/abc");
  assert.equal(listed, false, "an original must not cost a LIST");
});

test("the thumbnail listing is cached, so one media id costs one LIST", async () => {
  let lists = 0;
  const s3 = { send: async () => { lists++; return { Contents: [{ Key: "local_thumbnails/AG/TQ/x/240-240-image-jpeg-scale" }] }; } };
  const store = new Map();
  const cache = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) };
  const args = { serverName: "41chan.net", mediaId: "AGTQx", isLocal: true, thumbSize: 240, cache };
  await resolveR2Key(s3, "b", args);
  await resolveR2Key(s3, "b", args);
  assert.equal(lists, 1, "second request must be served from cache");
});

// ONE FILE PER IMAGE: a local original resolves through canon.js's index to
// the one stripped file, and never falls back to Synapse's unstripped object.
const { canonicalOriginalKey, OriginalUnavailable } = require("./mediar2");
const { GetObjectCommand } = require("@aws-sdk/client-s3");

function fakeS3(objects) {
  const asked = [];
  return {
    asked,
    async send(cmd) {
      asked.push(cmd.input.Key || cmd.input.Prefix);
      if (cmd instanceof GetObjectCommand) {
        const body = objects[cmd.input.Key];
        if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => Buffer.from(JSON.stringify(body)) } };
      }
      return { Contents: [] };
    },
  };
}
const MEDIA = "AGTQdDqkdaQqsrSCxDyreanu";
const IDX = `index/local/${MEDIA}.json`;
const ONE = "media/0123456789abcdef0123456789abcdef.png";
const memCache = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };

test("a local original with an index is its ONE file, not Synapse's object", async () => {
  const s3 = fakeS3({ [IDX]: { kind: "canonical", key: ONE } });
  let asked = 0;
  const key = await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: MEDIA, isLocal: true, askCanon: async () => { asked++; } });
  assert.equal(key, ONE);
  assert.equal(asked, 0, "an index already there needs no canon call");
  assert.ok(!s3.asked.includes(localOriginalKey(MEDIA)), "Synapse's key is never even asked for");
});

test("no index yet: canon is asked NOW, and its answer is served", async () => {
  const s3 = fakeS3({});
  const cache = memCache();
  const key = await canonicalOriginalKey(s3, "b", { mediaId: MEDIA, cache, askCanon: async (id) => ({ kind: "canonical", key: ONE, id }) });
  assert.equal(key, ONE);
  assert.deepEqual(cache.m.get(`canonidx:${MEDIA}`).key, ONE, "cached: an index entry never changes");
});

test("canon unreachable is CANON_UNAVAILABLE -- never a fallback to the unstripped original", async () => {
  const s3 = fakeS3({});
  await assert.rejects(
    () => canonicalOriginalKey(s3, "b", { mediaId: MEDIA, askCanon: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof OriginalUnavailable && err.code === "CANON_UNAVAILABLE",
  );
});

test("an image canon refused is WITHHELD: there is no file without its prompt, so none is served", async () => {
  const s3 = fakeS3({ [IDX]: { kind: "refused", reason: "AVIF with an Exif item" } });
  await assert.rejects(
    () => canonicalOriginalKey(s3, "b", { mediaId: MEDIA, askCanon: async () => ({}) }),
    (err) => err instanceof OriginalUnavailable && err.code === "WITHHELD" && /AVIF/.test(err.message),
  );
});

test("not an image (canon indexes it where it is): that file, as it is", async () => {
  const s3 = fakeS3({ [IDX]: { kind: "source", key: localOriginalKey(MEDIA) } });
  assert.equal(await canonicalOriginalKey(s3, "b", { mediaId: MEDIA, askCanon: async () => ({}) }), localOriginalKey(MEDIA));
});

test("an index naming no file is an error, not a guess", async () => {
  const s3 = fakeS3({ [IDX]: { kind: "canonical" } });
  await assert.rejects(() => canonicalOriginalKey(s3, "b", { mediaId: MEDIA, askCanon: async () => ({}) }), OriginalUnavailable);
});

test("thumbnails and remote originals never ask canon", async () => {
  let asked = 0;
  const askCanon = async () => { asked++; return {}; };
  const s3 = fakeS3({});
  assert.equal(await resolveR2Key(s3, "b", { serverName: "x.org", mediaId: MEDIA, isLocal: false, askCanon }), remoteOriginalKey("x.org", MEDIA));
  await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: MEDIA, isLocal: true, thumbSize: 360, askCanon });
  assert.equal(asked, 0);
});

test("canon's 404 is GONE (a 404), not CANON_UNAVAILABLE (a retry forever)", async () => {
  const s3 = fakeS3({});
  await assert.rejects(
    () => canonicalOriginalKey(s3, "b", { mediaId: MEDIA, askCanon: async () => { throw Object.assign(new Error("no local media"), { status: 404 }); } }),
    (err) => err instanceof OriginalUnavailable && err.code === "GONE",
  );
});
