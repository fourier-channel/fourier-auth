"use strict";

// R2 key derivation for every class of Matrix media, so the gate can redirect
// instead of streaming.
//
// WHY. Operator ruling: "41chan is not supposed to hold media or serve media
// outside of site assets." Local originals already 302 to R2. Thumbnails and
// remote originals did not -- they streamed from Synapse through this process,
// 3,724 thumbnail requests in 24h measured from the booru's own nginx. Those
// are media bytes crossing this host, which the ruling forbids just as much as
// bytes at rest.
//
// Synapse's s3-storage-provider mirrors the local media store layout into the
// bucket, so three of the four shapes are pure string derivation:
//
//   local_content/<AA>/<BB>/<rest>
//   remote_content/<server>/<AA>/<BB>/<rest>
//   local_thumbnails/<AA>/<BB>/<rest>/<W>-<H>-<type>-<subtype>-<method>
//   remote_thumbnail/<server>/<AA>/<BB>/<rest>/<W>-<H>-<type>-<subtype>-<method>
//
// THUMBNAILS ARE NOT DERIVABLE, and that is the whole difficulty. The stored
// name carries the ACTUAL rendered dimensions, not the requested ones --
// `164-240-image-jpeg-scale` for a request that asked for 240x240 -- so the key
// cannot be computed from the request. Synapse knows the answer from its
// database; we deliberately do not go there. mediaauth.js already carries one
// documented coupling to Synapse's schema and calls it out as a liability, and
// a second one for a performance win would be a poor trade.
//
// Instead: LIST the object's own thumbnail prefix. It returns the handful of
// renditions that exist for exactly this media id, which is both the question
// being asked and immutable once written -- so it caches hard. One list per
// media id per six hours, against one stream of every thumbnail byte forever.

const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

const THUMB_KEYS_TTL = 6 * 60 * 60; // immutable once written; cache hard

function shard(mediaId) {
  return `${mediaId.slice(0, 2)}/${mediaId.slice(2, 4)}/${mediaId.slice(4)}`;
}

function localOriginalKey(mediaId) {
  return `local_content/${shard(mediaId)}`;
}

function remoteOriginalKey(serverName, mediaId) {
  return `remote_content/${serverName}/${shard(mediaId)}`;
}

function thumbnailPrefix(serverName, mediaId, isLocal) {
  return isLocal
    ? `local_thumbnails/${shard(mediaId)}/`
    : `remote_thumbnail/${serverName}/${shard(mediaId)}/`;
}

/**
 * Parse `<W>-<H>-<type>-<subtype>-<method>` off the end of a thumbnail key.
 * Returns null for anything that does not match, so an unexpected object in
 * the prefix is ignored rather than mis-chosen.
 */
function parseThumbName(key) {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const m = /^(\d+)-(\d+)-(.+)-(scale|crop)$/.exec(name);
  if (!m) return null;
  return { key, width: parseInt(m[1], 10), height: parseInt(m[2], 10), type: m[3], method: m[4] };
}

/**
 * The best stored rendition for a requested size.
 *
 * Prefers the requested method, then the smallest rendition at least as large
 * as asked for -- upscaling a smaller one would be visibly worse than the
 * proxy path it replaces. Falls back to the largest available when everything
 * stored is smaller, which is what Synapse itself would serve.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE. Synapse renders thumbnails on demand, so
 * the old proxy path could commission a size that did not exist yet. This
 * cannot: it chooses among renditions that already exist. Commissioning one
 * means Synapse renders it and streams it through this host, which is the
 * thing being removed.
 *
 * In practice the two agree. Synapse's render set tops out at 800x600, so an
 * 850 request -- what the booru's own <img> tags ask for -- resolved to the
 * 800 rendition on the old path too. The gate also snaps every request to
 * ALLOWED_THUMB_SIZES first, so the space of asks is small and well covered.
 * Where they differ, this serves a slightly LARGER image than asked for, and
 * those bytes travel R2 -> client without touching us.
 */
function pickThumbnail(candidates, want, method) {
  const parsed = candidates.map(parseThumbName).filter(Boolean);
  if (parsed.length === 0) return null;
  const byMethod = parsed.filter((c) => c.method === method);
  const pool = byMethod.length ? byMethod : parsed;
  const atLeast = pool.filter((c) => Math.max(c.width, c.height) >= want);
  if (atLeast.length) {
    return atLeast.reduce((a, b) =>
      Math.max(b.width, b.height) < Math.max(a.width, a.height) ? b : a);
  }
  return pool.reduce((a, b) =>
    Math.max(b.width, b.height) > Math.max(a.width, a.height) ? b : a);
}

/**
 * Which R2 key serves this request, or null to fall through to the proxy.
 *
 * Null is a first-class answer and the caller must honour it: R2 genuinely
 * does not hold everything (74 zero-byte failed federation fetches, and
 * anything uploaded in the seconds before store_synchronous completes). The
 * streaming path stays as the fallback for exactly those, which is why this
 * function never throws for a miss.
 */
// ONE FILE PER IMAGE (operator decree, restated 2026-09-30: "One file,
// always. One file, one source of metadata. Multiple surfaces." "All media
// links lead to the stripped metadata file.").
//
// A local ORIGINAL is no longer Synapse's object. fourier-tunnel's canon.js
// makes each Matrix image into ONE file -- its AI generation data stripped,
// stored as media/<md5>.<ext>, the layout every other surface already uses --
// and writes index/local/<mediaId>.json saying where it is. Synapse's own copy
// is moved to superseded/ for the operator to review. So the gate reads the
// index, and when there is none yet it asks canon to make one NOW, before it
// answers: no link may ever lead to a file that still carries a prompt.
//
// Thumbnails: ONE SET OF RENDITIONS TOO, and it is the booru's. Every image the
// booru holds already has Danbooru's variants in R2 (variants/<md5>/180x180.jpg,
// 360x360.jpg, 720x720.webp, sample.jpg), rendered when it was uploaded. Synapse
// renders its own set for the same image (local_thumbnails/...), and until
// 2026-09-30 every surface -- the booru included -- was served Synapse's while
// the booru's sat unused: two rendition sets of one image. Operator: "Matrix is
// supposed to be using one of the variants generated by the booru for its
// thumbnail." "There are no duplicates, Claude. They're not allowed."
//
// So a local thumbnail is the booru's variant whenever the booru holds the
// image (booruVariantKey), and Synapse's rendition only when it does not --
// avatars, DMs, images never posted -- where it is the one set there is.
// Synapse's renditions of booru-held images are moved to superseded/ by
// fourier-tunnel (canon.retireSynapseThumbnails). Remote media is unchanged.
const INDEX_TTL = 24 * 60 * 60; // an index entry is written once and never changes

class OriginalUnavailable extends Error {
  // code: "GONE" -- canon says there is no such image (404, permanent).
  //       "WITHHELD" -- canon refused it (a format it cannot verify that carries
  //                     metadata): there is no stripped file, so nothing is served.
  //       "CANON_UNAVAILABLE" -- canon could not be asked: try again, never the raw.
  constructor(code, message) {
    super(message);
    this.name = "OriginalUnavailable";
    this.code = code;
  }
}

async function readIndex(s3, bucket, mediaId) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `index/local/${mediaId}.json` }));
    return JSON.parse(Buffer.from(await out.Body.transformToByteArray()).toString("utf8"));
  } catch (err) {
    if (err && (err.name === "NoSuchKey" || err.name === "NotFound" || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
    throw err;
  }
}

/**
 * The R2 key of a local original: the one file canon.js made, asking canon
 * to make it when it does not exist yet. Throws OriginalUnavailable rather
 * than ever falling back to Synapse's unstripped object.
 */
async function canonicalOriginalKey(s3, bucket, { mediaId, cache, askCanon }) {
  const { idx } = await localIndex(s3, bucket, { mediaId, cache, askCanon });
  if ((idx.kind === "canonical" || idx.kind === "source") && typeof idx.key === "string" && idx.key) return idx.key;
  throw new OriginalUnavailable("CANON_UNAVAILABLE", `the index for ${mediaId} names no file`);
}

// canon's index for a local media id, asking canon to make it when there is
// none. `asked`: whether canon was asked just now. Throws OriginalUnavailable
// (GONE, WITHHELD, CANON_UNAVAILABLE) exactly as canonicalOriginalKey does.
async function localIndex(s3, bucket, { mediaId, cache, askCanon }) {
  const cacheKey = `canonidx:${mediaId}`;
  let idx = cache ? await cache.get(cacheKey).catch(() => null) : null;
  if (!idx) idx = await readIndex(s3, bucket, mediaId);
  let asked = false;
  if (!idx) {
    try {
      asked = true;
      idx = await askCanon(mediaId);
    } catch (err) {
      // canon's 404 is permanent (unknown, quarantined, or gone from the bucket):
      // answering "try again" would have clients retry forever.
      if (err && err.status === 404) throw new OriginalUnavailable("GONE", `no such image: ${err.message}`);
      throw new OriginalUnavailable("CANON_UNAVAILABLE", `canon could not make ${mediaId} canonical: ${err.message}`);
    }
  }
  if (!idx || typeof idx !== "object") throw new OriginalUnavailable("CANON_UNAVAILABLE", `canon gave no index for ${mediaId}`);
  if (cache && idx.kind) await cache.set(cacheKey, idx, INDEX_TTL).catch(() => {});
  if (idx.kind === "refused") {
    throw new OriginalUnavailable("WITHHELD", `withheld: its generation data could not be removed (${idx.reason || "no reason given"})`);
  }
  return { idx, asked };
}

// canon.js answers the gate over the docker network (fourier-tunnel's
// startCanonService). POST so a crawler following links never triggers it.
function canonClient({ axios, baseUrl, timeoutMs = 30000 }) {
  return async (mediaId) => {
    const resp = await axios.post(`${baseUrl}/canon/${encodeURIComponent(mediaId)}`, null, { timeout: timeoutMs, validateStatus: () => true });
    if (resp.status === 200 && resp.data && typeof resp.data === "object") return resp.data;
    const why = resp.data && resp.data.error ? resp.data.error : `status ${resp.status}`;
    const err = new Error(why);
    err.status = resp.status;
    throw err;
  };
}

// Danbooru's variant types, by the longest side each one fits in. `sample` is
// Danbooru's 850 px rendition; `original`/`full` are not thumbnails.
const BOORU_VARIANT_BOX = { "180x180": 180, "360x360": 360, "720x720": 720, sample: 850 };
// A variant set is written once, with the upload, and never changes.
const VARIANTS_TTL = THUMB_KEYS_TTL;
// An image the booru does not hold YET may be posted any minute, so "no
// variants" is remembered briefly. fourier-tunnel waits longer than this after
// posting before it moves Synapse's renditions away (canon.js
// RETIRE_THUMBNAILS_AFTER_MS), so a cached "no" can never point the gate at a
// Synapse rendition that is no longer there.
const NO_VARIANTS_TTL = 10 * 60;

const isMd5 = (x) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);

function parseVariantName(key) {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const m = /^([a-z0-9]+)\.[a-z0-9]+$/.exec(name);
  if (!m || !Object.prototype.hasOwnProperty.call(BOORU_VARIANT_BOX, m[1])) return null;
  return { key, box: BOORU_VARIANT_BOX[m[1]] };
}

/**
 * The booru variant for a requested size: the smallest that is at least as
 * large as asked for, else the largest there is -- the same rule pickThumbnail
 * applies to Synapse's renditions. Danbooru's variants are fitted, never
 * cropped, so a `crop` ask gets the fitted rendition; the client crops it.
 */
function pickVariant(keys, want) {
  const parsed = keys.map(parseVariantName).filter(Boolean);
  if (parsed.length === 0) return null;
  const atLeast = parsed.filter((v) => v.box >= want);
  if (atLeast.length) return atLeast.reduce((a, b) => (b.box < a.box ? b : a));
  return parsed.reduce((a, b) => (b.box > a.box ? b : a));
}

/**
 * The booru's variant for a local Matrix image, or null when the booru does
 * not hold the image. Found through canon's index: the booru post carries the
 * image's one file (idx.md5), or -- for tunnel posts made before stripping
 * existed -- the unstripped original it was uploaded from (idx.rawMd5).
 * `fresh` skips the cached "no", for a caller about to fall back.
 */
async function booruVariantKey(s3, bucket, { mediaId, thumbSize, cache, fresh = false }) {
  const idxCacheKey = `canonidx:${mediaId}`;
  const noIdxCacheKey = `canonidx-none:${mediaId}`;
  let idx = cache ? await cache.get(idxCacheKey).catch(() => null) : null;
  if (!idx) {
    if (!fresh && cache && await cache.get(noIdxCacheKey).catch(() => null)) return null;
    idx = await readIndex(s3, bucket, mediaId);
    if (!idx) {
      if (cache) await cache.set(noIdxCacheKey, true, NO_VARIANTS_TTL).catch(() => {});
      return null;
    }
    if (cache && idx.kind) await cache.set(idxCacheKey, idx, INDEX_TTL).catch(() => {});
  }
  // idx.booru.md5: where canon found the booru holding it when that is neither
  // md5 canon computed (a post made under older strip rules).
  const md5s = [...new Set([idx.md5, idx.rawMd5, idx.raw_md5, idx.booru && idx.booru.md5].filter(isMd5))];
  for (const md5 of md5s) {
    const ck = `variants:${md5}`;
    let keys = !fresh && cache ? await cache.get(ck).catch(() => null) : null;
    if (!Array.isArray(keys)) {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `variants/${md5}/`, MaxKeys: 50 }));
      keys = (out.Contents || []).map((o) => o.Key);
      if (cache) await cache.set(ck, keys, keys.length ? VARIANTS_TTL : NO_VARIANTS_TTL).catch(() => {});
    }
    const chosen = pickVariant(keys, thumbSize);
    if (chosen) return chosen.key;
  }
  return null;
}

async function resolveR2Key(s3, bucket, { serverName, mediaId, isLocal, thumbSize, method = "scale", cache, askCanon }) {
  if (!thumbSize) {
    if (isLocal && askCanon) return canonicalOriginalKey(s3, bucket, { mediaId, cache, askCanon });
    return isLocal ? localOriginalKey(mediaId) : remoteOriginalKey(serverName, mediaId);
  }

  // The booru's variant first: when the booru holds the image, its variants
  // ARE the renditions (see the note above INDEX_TTL).
  if (isLocal) {
    const variant = await booruVariantKey(s3, bucket, { mediaId, thumbSize, cache });
    if (variant) return variant;
  }

  const prefix = thumbnailPrefix(serverName, mediaId, isLocal);
  const cacheKey = `thumbkeys:${isLocal ? "local" : serverName}:${mediaId}`;

  let names = cache ? await cache.get(cacheKey).catch(() => null) : null;
  if (!Array.isArray(names)) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100 }));
    names = (out.Contents || []).map((o) => o.Key);
    if (cache) await cache.set(cacheKey, names, THUMB_KEYS_TTL).catch(() => {});
  }
  if (names.length === 0) {
    // No Synapse rendition either. Look for the booru's variants again past
    // any cached "no" -- the image may have been uploaded since -- and then
    // ask canon (thumbnailOfLastResort). Never Synapse, which would RENDER
    // one: a second set of renditions.
    if (!isLocal) return null;
    const variant = await booruVariantKey(s3, bucket, { mediaId, thumbSize, cache, fresh: true });
    if (variant || !askCanon) return variant;
    return thumbnailOfLastResort(s3, bucket, { mediaId, thumbSize, cache, askCanon });
  }

  const chosen = pickThumbnail(names, thumbSize, method);
  return chosen ? chosen.key : null;
}

// NO RENDITION ANYWHERE. Synapse runs with dynamic_thumbnails, so it renders
// nothing at upload, and nothing it would render on demand is ever asked of it:
// the Worker sends every thumbnail request here and this gate has no Synapse
// fallback. So a new image's first thumbnail -- a DM picture, an avatar --
// arrives before anything has rendered it. Ask canon, which makes the image
// its one file AND gives it a booru upload, waiting for the variants
// (fourier-tunnel canon.js ensureBooruRecord); then look once more. If the
// booru still has none -- it refused the file, or is still rendering -- the
// image itself is the thumbnail: its one stripped file, which every client
// scales. Never Synapse's object. Not an image (canon left it where it is):
// no thumbnail, as before.
async function thumbnailOfLastResort(s3, bucket, { mediaId, thumbSize, cache, askCanon }) {
  const { idx, asked } = await localIndex(s3, bucket, { mediaId, cache, askCanon });
  if (idx.kind !== "canonical" || typeof idx.key !== "string" || !idx.key) return null;
  if (asked) {
    const variant = await booruVariantKey(s3, bucket, { mediaId, thumbSize, cache, fresh: true });
    if (variant) return variant;
  }
  return idx.key;
}

module.exports = {
  localOriginalKey,
  remoteOriginalKey,
  thumbnailPrefix,
  parseThumbName,
  pickThumbnail,
  parseVariantName,
  pickVariant,
  booruVariantKey,
  resolveR2Key,
  canonicalOriginalKey,
  canonClient,
  OriginalUnavailable,
  THUMB_KEYS_TTL,
  INDEX_TTL,
  VARIANTS_TTL,
  NO_VARIANTS_TTL,
};
