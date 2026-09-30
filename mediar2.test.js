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

// An image the booru does not hold has no canon index here: GetObject is a 404.
const NO_INDEX = (cmd) => cmd.constructor.name === "GetObjectCommand";
const notFound = () => { throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }); };

test("an empty prefix resolves to null so the caller falls back to streaming", async () => {
  const s3 = { send: async (cmd) => (NO_INDEX(cmd) ? notFound() : { Contents: [] }) };
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
  const s3 = { send: async (cmd) => {
    if (NO_INDEX(cmd)) return notFound();
    lists++;
    return { Contents: [{ Key: "local_thumbnails/AG/TQ/x/240-240-image-jpeg-scale" }] };
  } };
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

// ONE SET OF RENDITIONS (operator, 2026-09-30): when the booru holds the image,
// a Matrix thumbnail is the booru's variant, and Synapse's renditions are not
// even listed.
const { pickVariant, parseVariantName, booruVariantKey, NO_VARIANTS_TTL } = require("./mediar2");
const { ListObjectsV2Command } = require("@aws-sdk/client-s3");

const MD5 = "60afcbe772caded03b35238685f63696";
const RAW = "535f0df6cc535647290653d9ce222874";
const VARIANTS = ["180x180.jpg", "360x360.jpg", "720x720.webp", "sample.jpg"].map((n) => `variants/${MD5}/${n}`);

function bucket({ index, variants = {}, synapse = [] }) {
  const asked = [];
  return {
    asked,
    async send(cmd) {
      if (cmd instanceof GetObjectCommand) {
        asked.push(`get ${cmd.input.Key}`);
        if (!index) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => Buffer.from(JSON.stringify(index)) } };
      }
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix;
        asked.push(`list ${prefix}`);
        if (prefix.startsWith("variants/")) return { Contents: (variants[prefix] || []).map((Key) => ({ Key })) };
        return { Contents: synapse.map((Key) => ({ Key })) };
      }
      throw new Error("unexpected command");
    },
  };
}

test("variant names: only Danbooru's thumbnail types count", () => {
  assert.equal(parseVariantName(`variants/${MD5}/360x360.jpg`).box, 360);
  assert.equal(parseVariantName(`variants/${MD5}/sample.jpg`).box, 850);
  assert.equal(parseVariantName(`variants/${MD5}/original.png`), null);
  assert.equal(parseVariantName(`variants/${MD5}/full.webp`), null);
});

test("the smallest variant at least as large as asked, else the largest", () => {
  assert.match(pickVariant(VARIANTS, 96).key, /180x180/);
  assert.match(pickVariant(VARIANTS, 180).key, /180x180/);
  assert.match(pickVariant(VARIANTS, 240).key, /360x360/);
  assert.match(pickVariant(VARIANTS, 640).key, /720x720/);
  assert.match(pickVariant(VARIANTS, 800).key, /sample/);
  assert.match(pickVariant(VARIANTS, 5000).key, /sample/);
  assert.equal(pickVariant([], 240), null);
});

test("a booru-held image's thumbnail is the booru's variant; Synapse's are never listed", async () => {
  const s3 = bucket({
    index: { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5, rawMd5: RAW },
    variants: { [`variants/${MD5}/`]: VARIANTS },
    synapse: ["local_thumbnails/cb/kB/x/320-231-image-jpeg-scale"],
  });
  const key = await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: "cbkBleYzcztAYaTcEqsrBmyx", isLocal: true, thumbSize: 320 });
  assert.equal(key, `variants/${MD5}/360x360.jpg`);
  assert.ok(!s3.asked.some((a) => a.includes("local_thumbnails")), "Synapse's renditions must not be consulted");
});

test("a tunnel post made before stripping keeps its variants under the RAW md5", async () => {
  const s3 = bucket({
    index: { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5, rawMd5: RAW },
    variants: { [`variants/${RAW}/`]: [`variants/${RAW}/180x180.jpg`, `variants/${RAW}/sample.jpg`] },
  });
  assert.equal(await booruVariantKey(s3, "b", { mediaId: "x", thumbSize: 180 }), `variants/${RAW}/180x180.jpg`);
});

test("an image the booru does not hold keeps Synapse's renditions, its only set", async () => {
  const s3 = bucket({ index: null, synapse: ["local_thumbnails/AG/TQ/x/96-96-image-jpeg-crop", "local_thumbnails/AG/TQ/x/320-240-image-jpeg-scale"] });
  const key = await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: "AGTQx", isLocal: true, thumbSize: 320 });
  assert.match(key, /320-240-image-jpeg-scale/);
});

test("'no index' is remembered briefly, so an avatar does not cost an index read per request", async () => {
  const s3 = bucket({ index: null, synapse: ["local_thumbnails/AG/TQ/x/96-96-image-jpeg-crop"] });
  const cache = memCache();
  const args = { serverName: "41chan.net", mediaId: "AGTQx", isLocal: true, thumbSize: 96, cache };
  await resolveR2Key(s3, "b", args);
  await resolveR2Key(s3, "b", args);
  assert.equal(s3.asked.filter((a) => a.startsWith("get ")).length, 1);
});

test("no Synapse rendition and a cached 'no variants': look again before falling back", async () => {
  // Posted since the "no" was cached. Falling back would make Synapse RENDER a
  // thumbnail -- a second set of renditions for an image the booru now holds.
  const s3 = bucket({
    index: { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5 },
    variants: { [`variants/${MD5}/`]: VARIANTS },
  });
  const cache = memCache();
  await cache.set(`variants:${MD5}`, [], NO_VARIANTS_TTL);
  const key = await resolveR2Key(s3, "b", { serverName: "41chan.net", mediaId: "x", isLocal: true, thumbSize: 180, cache });
  assert.equal(key, `variants/${MD5}/180x180.jpg`);
});

test("remote media never looks for booru variants", async () => {
  const s3 = bucket({ index: { kind: "canonical", md5: MD5 }, variants: { [`variants/${MD5}/`]: VARIANTS }, synapse: ["remote_thumbnail/m.org/AG/TQ/x/320-240-image-jpeg-scale"] });
  const key = await resolveR2Key(s3, "b", { serverName: "m.org", mediaId: "AGTQx", isLocal: false, thumbSize: 320 });
  assert.match(key, /remote_thumbnail/);
  assert.ok(!s3.asked.some((a) => a.startsWith("get ") || a.includes("variants/")));
});
