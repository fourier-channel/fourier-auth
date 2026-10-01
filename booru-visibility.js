"use strict";

// MAY THIS VIEWER SEE A BOORU POST FOR THIS MD5? -- asked of the booru itself.
//
// Why this exists (leak audit, 2026-10-01). /booru/<md5>.<ext> served ANY md5
// held in R2 to anyone: troll-jailed images (30,550 distinct md5 in sampling's
// jail; 15 of 15 sampled resolved), images never posted, posts deleted. The
// ruling it rested on -- "an md5 you were never handed a URL for is one the
// booru never rendered for you" -- fails because 4chan's API publishes every
// image's md5, so the digest is not a secret and never was.
//
// The rule now: the gate releases a booru object only when a post exists for
// that md5 that the requester may see. "May see" is the BOORU's answer, not a
// copy of it kept here: PostPolicy#can_see_media? is what decides whether the
// booru hands a viewer a post's md5 at all (deleted -> admins and the uploader
// only; gated tags such as troll_jail -> dropped from an anonymous viewer's
// results entirely). So the question is the booru's own search API, asked the
// way a reader would ask it:
//
//   GET <booru>/posts.json?tags=md5:<a>,<b>,...&only=md5,is_deleted&limit=N
//
// A row counts only when it carries the md5 back (the booru strips md5 from a
// post the viewer may not see the media of) -- and, for an anonymous ask, is
// not deleted. An md5 absent from the answer is refused -- whether it was
// never posted, is jailed, or is deleted, the gate cannot tell and must not
// need to.
//
// WHO ASKS. Anonymous first, always: that answer is shared by every viewer and
// cached. Only when it is no AND the request carries the reader's own booru
// session is the booru asked AS THAT READER, so an admin still sees the deleted
// post they are reviewing, a Gold reader still sees a gated-tag image, and the
// uploader still sees their own deleted post -- by the booru's rule, with no
// list of privileged people kept in this service.
//
// COST. A booru page draws dozens of thumbnails at once. Asks are coalesced
// per md5 and batched per viewer: everything that arrives within WINDOW_MS
// goes out as one IN query (measured 2026-10-01 from inside the fourier-auth
// container: three md5s, 115 ms cold). Answers are cached in Redis --
// positive longer than negative, because a positive answer is the one whose
// staleness matters (a just-jailed image) and a negative one only delays a
// just-posted image.
//
// BATCH CEILING = 20, and it is not a tuning knob. Below the booru's
// full_browsing_level (anonymous is below it) a search returns at most
// restricted_browsing_per_page = 20 rows and clamps ?limit= to that. md5 is
// unique per post, so a batch of 20 md5s can never need more than 20 rows --
// but a batch of 21 could silently lose one, and a lost row is a refused
// picture. If that booru setting is ever LOWERED, lower this with it.
//
// FAILURE. If the booru cannot be asked -- timeout, refused, a non-200, a body
// that is not a JSON array -- every waiting ask rejects with BooruUnavailable
// and NOTHING is cached. The route answers 503 (fail CLOSED) and logs it; a
// silent fall-open here would be the very leak this file closes.

const MAX_BATCH = 20;
const WINDOW_MS = 8;
const TTL = {
  // Bounds how long a just-jailed or just-deleted image stays servable to a
  // viewer who already had it allowed. Together with the Worker's 60 s
  // decision cache for booru media, the worst case is about three minutes.
  visible: 120,
  // Bounds how long a just-posted image stays refused to someone who asked
  // before it was posted. The external sampling view never links an unposted
  // image, so in practice this is only ever paid by someone guessing.
  hidden: 20,
  // Per-reader answers, keyed on a hash of their booru session. Short both
  // ways: an admin's view changes as they moderate.
  viewerVisible: 60,
  viewerHidden: 20,
};

class BooruUnavailable extends Error {
  constructor(cause) {
    const why = (cause && (cause.code || cause.message)) || String(cause);
    super(`booru visibility unavailable: ${why}`);
    this.name = "BooruUnavailable";
    this.cause = cause;
  }
}

/**
 * The booru's posts API as a function: md5s in, the Set of those the viewer
 * may see out. THROWS for "could not find out"; returns a (possibly empty)
 * Set for an answer.
 *
 *   viewer: null for anonymous, or { sessionCookie, clientIp } to ask as that
 *   reader. Only the booru session cookie is forwarded -- never the rest of the
 *   reader's cookies -- and the reader's IP rides as X-Forwarded-For so the
 *   booru records their own address on their account, not this container's.
 */
function booruPostsClient({ axios, baseUrl, cookieName = "_danbooru2_session", timeoutMs = 4000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return async function fetchVisible(md5s, viewer = null) {
    if (!Array.isArray(md5s) || md5s.length === 0) return new Set();
    if (md5s.length > MAX_BATCH) throw new Error(`batch of ${md5s.length} exceeds the booru's ${MAX_BATCH}-row ceiling`);
    const headers = { Accept: "application/json" };
    if (viewer && viewer.sessionCookie) {
      headers.Cookie = `${cookieName}=${viewer.sessionCookie}`;
      if (viewer.clientIp) headers["X-Forwarded-For"] = viewer.clientIp;
    }
    const r = await axios.get(`${base}/posts.json`, {
      params: { tags: `md5:${md5s.join(",")}`, only: "md5,is_deleted", limit: md5s.length },
      headers,
      timeout: timeoutMs,
      // Never follow a redirect: a 302 to a login page is not an answer.
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (r.status !== 200) throw new Error(`booru posts.json answered ${r.status}`);
    if (!Array.isArray(r.data)) throw new Error("booru posts.json answered something that is not a list");
    // The md5 coming back IS the booru's yes: it strips md5 from any post the
    // asker may not see the media of (PostPolicy#can_see_media?). For an
    // anonymous ask a deleted row is refused as well, belt and braces, since
    // the booru never shows anonymous readers a deleted post's media. For a
    // reader's own ask it is NOT: an admin reviewing a deleted post, or its
    // uploader appealing, is handed the md5 precisely because they may see it.
    const want = new Set(md5s);
    const seen = new Set();
    for (const row of r.data) {
      if (!row || typeof row.md5 !== "string" || !want.has(row.md5)) continue;
      if (!viewer && row.is_deleted === true) continue;
      seen.add(row.md5);
    }
    return seen;
  };
}

/**
 * deps:
 *   fetchVisible(md5s, viewer) -> Set<md5>   (throws = could not find out)
 *   cacheGet(key) -> value|null, cacheSet(key, value, ttlSeconds)
 *   hashKey(string) -> string                (session cookies never become keys)
 * opts: { ttl, windowMs, maxBatch, setTimer }
 */
function createBooruVisibility(deps, opts = {}) {
  const ttl = { ...TTL, ...(opts.ttl || {}) };
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const maxBatch = Math.min(opts.maxBatch ?? MAX_BATCH, MAX_BATCH);
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));

  // groupKey -> { viewer, pending: Map<md5, {resolve, reject}>, timer }
  const groups = new Map();
  // groupKey + md5 -> Promise<boolean>; one ask per md5 per viewer in flight.
  const inflight = new Map();

  function flush(groupKey) {
    const g = groups.get(groupKey);
    if (!g) return;
    groups.delete(groupKey);
    if (g.timer) clearTimer(g.timer);
    const batch = g.pending;
    const md5s = [...batch.keys()];
    (async () => {
      let seen;
      try {
        seen = await deps.fetchVisible(md5s, g.viewer);
      } catch (err) {
        const e = err instanceof BooruUnavailable ? err : new BooruUnavailable(err);
        for (const [md5, d] of batch) { inflight.delete(groupKey + md5); d.reject(e); }
        return;
      }
      for (const [md5, d] of batch) {
        const v = seen.has(md5);
        const life = g.viewer ? (v ? ttl.viewerVisible : ttl.viewerHidden) : (v ? ttl.visible : ttl.hidden);
        // Not awaited: the reader is not kept waiting on Redis. A miss in the
        // gap only costs one more ask, never a wrong answer.
        Promise.resolve().then(() => deps.cacheSet(cacheKey(groupKey, md5), { v }, life)).catch(() => {});
        inflight.delete(groupKey + md5);
        d.resolve(v);
      }
    })();
  }

  function cacheKey(groupKey, md5) {
    return groupKey === "anon" ? `boorusees:${md5}` : `boorusees:${groupKey}:${md5}`;
  }

  function enqueue(groupKey, viewer, md5) {
    const fk = groupKey + md5;
    const existing = inflight.get(fk);
    if (existing) return existing;
    let g = groups.get(groupKey);
    if (!g) { g = { viewer, pending: new Map(), timer: null }; groups.set(groupKey, g); }
    const p = new Promise((resolve, reject) => g.pending.set(md5, { resolve, reject }));
    inflight.set(fk, p);
    if (g.pending.size >= maxBatch) flush(groupKey);
    else if (!g.timer) g.timer = setTimer(() => flush(groupKey), windowMs);
    return p;
  }

  async function ask(groupKey, viewer, md5) {
    const hit = await deps.cacheGet(cacheKey(groupKey, md5)).catch(() => null);
    if (hit && typeof hit.v === "boolean") return hit.v;
    return enqueue(groupKey, viewer, md5);
  }

  /**
   * true when a post for md5 exists that this viewer may see. viewer is null
   * (anonymous) or { sessionCookie, clientIp }. Anonymous is asked first; the
   * viewer is asked only when anonymous is refused. Throws BooruUnavailable.
   */
  async function sees(md5, viewer = null) {
    if (await ask("anon", null, md5)) return true;
    if (!viewer || !viewer.sessionCookie) return false;
    return ask("v" + deps.hashKey(viewer.sessionCookie), viewer, md5);
  }

  return { sees, pendingCount: () => inflight.size };
}

module.exports = { createBooruVisibility, booruPostsClient, BooruUnavailable, MAX_BATCH, TTL };
