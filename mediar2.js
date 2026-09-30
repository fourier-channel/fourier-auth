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
// Thumbnails are unchanged: Synapse renders them without the metadata, and
// they stay the one set of renditions. Remote media is unchanged.
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
  const cacheKey = `canonidx:${mediaId}`;
  let idx = cache ? await cache.get(cacheKey).catch(() => null) : null;
  if (!idx) idx = await readIndex(s3, bucket, mediaId);
  if (!idx) {
    try {
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
  if ((idx.kind === "canonical" || idx.kind === "source") && typeof idx.key === "string" && idx.key) return idx.key;
  throw new OriginalUnavailable("CANON_UNAVAILABLE", `the index for ${mediaId} names no file`);
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

async function resolveR2Key(s3, bucket, { serverName, mediaId, isLocal, thumbSize, method = "scale", cache, askCanon }) {
  if (!thumbSize) {
    if (isLocal && askCanon) return canonicalOriginalKey(s3, bucket, { mediaId, cache, askCanon });
    return isLocal ? localOriginalKey(mediaId) : remoteOriginalKey(serverName, mediaId);
  }

  const prefix = thumbnailPrefix(serverName, mediaId, isLocal);
  const cacheKey = `thumbkeys:${isLocal ? "local" : serverName}:${mediaId}`;

  let names = cache ? await cache.get(cacheKey).catch(() => null) : null;
  if (!Array.isArray(names)) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100 }));
    names = (out.Contents || []).map((o) => o.Key);
    if (cache) await cache.set(cacheKey, names, THUMB_KEYS_TTL).catch(() => {});
  }
  if (names.length === 0) return null;

  const chosen = pickThumbnail(names, thumbSize, method);
  return chosen ? chosen.key : null;
}

module.exports = {
  localOriginalKey,
  remoteOriginalKey,
  thumbnailPrefix,
  parseThumbName,
  pickThumbnail,
  resolveR2Key,
  canonicalOriginalKey,
  canonClient,
  OriginalUnavailable,
  THUMB_KEYS_TTL,
  INDEX_TTL,
};
