"use strict";

// A PUBLISHED PAGE'S GRANT -- the one way past the booru's visibility answer.
//
// Operator ruling 2026-10-02 (memory jailed-is-not-restricted): a publication
// is the operator's deliberate grant of a thread's content, for the life of
// the link -- a random hash that can expire, and once the page is gone so is
// the access. Restricted-tag images (legal; hidden from signed-out readers on
// the booru) ARE shown on a published page. Jailed images are shown nowhere.
//
// HOW. A live published page sets fourier_pub_<hash>=1 on the gate's path
// (fourier-sampling publications.ts publicationCookie). When the booru says a
// reader may not see an md5 and the request carries such cookies, the gate
// asks sampling for each publication's /p/<hash>/data -- the same document the
// page renders from -- and allows the md5 only when that publication answers
// 200 (live) AND lists the md5 among the media the page actually shows:
// non-empty md5_hex, withheld false, and a src (the page links it; an image
// not yet posted gets a "Post in Progress" placeholder and no URL, so it is not
// shown and not granted). Jailed media is already redacted there to an empty
// md5, so a cookie can never reach it.
//
// The cookie proves nothing by itself: its NAME is the link's hash, which is
// the secret a reader of the page already holds, and every grant is re-checked
// against the live page. Each publication's md5 set is cached at most 60 s, so
// an expired or unpublished page stops granting within a minute.
//
// AT MOST MAX_PUBS publications are consulted per request, so a reader cannot
// make one picture cost a hundred lookups by collecting cookies. The Worker
// sends the page the picture was requested from first (its Referer).
//
// FAILURE. Sampling unreachable -> PublicationsUnavailable: the publication
// path fails CLOSED (the route answers 503, logs loudly, turns its lamp red).
// The ordinary booru path never comes here and is unaffected.

const MAX_PUBS = 8;
const TTL_SECONDS = 60;
const PUB_COOKIE = /^fourier_pub_([0-9a-f]{32})$/;

class PublicationsUnavailable extends Error {
  constructor(cause) {
    const why = (cause && (cause.code || cause.message)) || String(cause);
    super(`publication grants unavailable: ${why}`);
    this.name = "PublicationsUnavailable";
    this.cause = cause;
  }
}

/** The publication hashes a request's cookies name: well-formed, in order, at most MAX_PUBS. */
function pubHashes(cookies) {
  const out = [];
  if (!cookies || typeof cookies !== "object") return out;
  for (const name of Object.keys(cookies)) {
    const m = PUB_COOKIE.exec(name);
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= MAX_PUBS) break;
  }
  return out;
}

/** The md5s a published page's data shows. */
function shownMd5s(data) {
  const out = new Set();
  const posts = data && Array.isArray(data.posts) ? data.posts : [];
  for (const p of posts) {
    const m = p && p.media;
    if (!m || m.withheld !== false) continue;
    if (typeof m.md5_hex !== "string" || !/^[0-9a-f]{32}$/.test(m.md5_hex)) continue;
    if (typeof m.src !== "string" || m.src.length === 0) continue;
    out.add(m.md5_hex);
  }
  return out;
}

/**
 * Sampling's published data as a function: hash in, { live, md5s } out.
 * 404 is an ANSWER (expired, unpublished, never existed); anything else that
 * is not a 200 with a thread is "could not find out", and throws.
 */
function samplingPublicationClient({ axios, baseUrl, timeoutMs = 4000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return async function fetchPublication(hash) {
    if (!/^[0-9a-f]{32}$/.test(hash)) return { live: false, md5s: [] };
    const r = await axios.get(`${base}/p/${hash}/data`, {
      headers: { Accept: "application/json" },
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (r.status === 404) return { live: false, md5s: [] };
    if (r.status !== 200 || !r.data || typeof r.data !== "object" || !Array.isArray(r.data.posts)) {
      throw new Error(`sampling /p/<hash>/data answered ${r.status}`);
    }
    return { live: true, md5s: [...shownMd5s(r.data)] };
  };
}

/**
 * deps: fetchPublication(hash) -> {live, md5s} (throws = could not find out),
 *       cacheGet(key), cacheSet(key, value, ttlSeconds)
 */
function createPublicationGrants(deps, opts = {}) {
  const ttl = Math.min(opts.ttlSeconds ?? TTL_SECONDS, TTL_SECONDS);
  const inflight = new Map();

  async function publication(hash) {
    const key = `pubgrant:${hash}`;
    const hit = await deps.cacheGet(key).catch(() => null);
    if (hit && typeof hit.live === "boolean" && Array.isArray(hit.md5s)) return hit;
    let p = inflight.get(hash);
    if (!p) {
      p = (async () => {
        const v = await deps.fetchPublication(hash);
        const row = { live: v.live === true, md5s: v.live === true ? [...v.md5s] : [] };
        await deps.cacheSet(key, row, ttl).catch(() => {});
        return row;
      })().finally(() => inflight.delete(hash));
      inflight.set(hash, p);
    }
    return p;
  }

  /**
   * true when one of these publications is live and shows md5. Throws
   * PublicationsUnavailable when none granted and any could not be asked.
   */
  async function grants(md5, hashes) {
    const list = (hashes || []).slice(0, MAX_PUBS);
    let failure = null;
    const results = await Promise.all(list.map((h) => publication(h).catch((e) => { failure = failure || e; return null; })));
    if (results.some((r) => r && r.live && r.md5s.includes(md5))) return true;
    if (failure) throw new PublicationsUnavailable(failure);
    return false;
  }

  return { grants, inflightCount: () => inflight.size };
}

module.exports = { createPublicationGrants, samplingPublicationClient, pubHashes, shownMd5s, PublicationsUnavailable, MAX_PUBS, TTL_SECONDS };
