"use strict";

// THE QUARANTINE -- flagged and banished tags, refused at this gate's own doors.
//
// Operator rulings 2026-10-12 (memory flagged-tags-are-a-review-quarantine):
// an admin can FLAG any tag for review, and its posts disappear at once from
// everyone below Admin; a BANISHED tag's posts disappear from everyone. Reach:
// "everywhere, like jail". The booru door (/booru/<md5>) needs nothing from
// this file -- it asks the booru's posts API, which hides those posts itself.
// Two doors here say yes WITHOUT asking the booru which posts a reader sees:
//
//   1. the Matrix door (/media/<server>/<id>), which asks the ROOM; and
//   2. a published page's grant (booru-route.js), which asks SAMPLING.
//
// Both now refuse any image the booru names in its quarantine document:
//
//   GET <booru>/fourier_jail/release.json?quarantine=1[&after=<post id>]
//   -> { generation, flagged|null, banished|null,
//        posts: [{ id, md5, mxc|null, flagged, banished, jailed }], next_after|null }
//
// read as the booru account `gate` (Danbooru.config.fourier_quarantine_reader_names),
// whose key is scoped to that one action. The names are null for this reader
// and ignored if present: fourier-auth holds md5s and mxc ids, never a tag.
// EVERY row is refused, whatever its flags say: that includes a post carrying
// only troll_jail (2026-10-12: jailed means deleted and is shown nowhere, so
// the Matrix door refuses jailed Matrix media too).
//
// ONE OPENING (operator ruling 2026-10-12). A FLAGGED post that came from
// Matrix -- flagged, not banished, not jailed, mxc-sourced: reviewable(md5) -- is what an
// Admin reviews on the booru, and the booru hands them its booru-door address.
// The booru door admits that file to a reader whose OWN booru session sees the
// post (booru-route.js). Rooms still refuse it to everyone.
//
// HOW FRESH. Polled every 30 s with If-None-Match (a 304 counts as a read).
// From a flag landing to a refusal: about 90 s on the grant path (30 s poll +
// the Worker's 60 s booru decision cache) and about 3 min at the Matrix door
// (30 s poll + the Worker's 150 s Matrix decision cache, lowered from 240 s on
// 2026-10-12 so the Matrix door meets jail's bound).
//
// STALE GRACE (operator ruling 2026-10-12). When the booru cannot be read,
// the doors keep deciding on the LAST GOOD document for up to STALE_MS (30
// min); a tag flagged during the outage takes effect when the booru returns.
// It is loud from the first minute: health() is red once the last good read is
// older than ALERT_MS, and the crossing is logged once. Past STALE_MS, and
// before any good read at all, check() THROWS QuarantineUnavailable: the
// Matrix door answers 503 to every reader and the grant path refuses (fail
// closed). A document that fails its shape check is not a read -- it is never
// taken for "nothing is quarantined". The sets live in this process's memory
// only: never written to Redis, never logged.

const MAX_RESTARTS = 3;
const STALE_MS = 30 * 60_000;
const ALERT_MS = 60_000;
const MAX_PAGES = 1000;
const PATH = "/fourier_jail/release.json";

const ACCOUNT_REMEDY =
  "this account is not in Danbooru.config.fourier_quarantine_reader_names, or its api key is wrong " +
  "(BOORU_QUARANTINE_LOGIN / BOORU_QUARANTINE_API_KEY in fourier-auth's .env)";
const OLD_BOORU =
  "the booru is older than the quarantine build (no generation/posts in GET /fourier_jail/release.json?quarantine=1) -- deploy chanbooru";

class QuarantineUnavailable extends Error {
  constructor(message) {
    super(`quarantine unreadable: ${message}`);
    this.name = "QuarantineUnavailable";
  }
}

const isMd5 = (x) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);

/** null when both credentials are set; otherwise what to set, naming both. */
function quarantineConfigProblem({ login, apiKey } = {}) {
  if (login && apiKey) return null;
  const missing = [!login && "BOORU_QUARANTINE_LOGIN", !apiKey && "BOORU_QUARANTINE_API_KEY"].filter(Boolean).join(" and ");
  return `${missing} unset. Set both BOORU_QUARANTINE_LOGIN and BOORU_QUARANTINE_API_KEY ` +
    "(the booru account named in Danbooru.config.fourier_quarantine_reader_names, normally gate, and its api key, " +
    "entered into fourier-auth's gitignored .env with read -s). Until they are, every Matrix picture answers 503 " +
    "and published pages' grants are refused (fail closed).";
}

/**
 * The quarantine document as a function: ({ ifNoneMatch }) ->
 *   { notModified: true }                                   (304 to that ETag)
 *   { generation, etag, md5s: Set, mxcs: Set, reviewMd5s: Set }   (every page read)
 * reviewMd5s: the md5s of FLAGGED Matrix posts -- flagged === true, banished
 * and jailed not true, mxc set -- which the booru door may open to a reviewer.
 * THROWS for "could not find out", including a failed shape check.
 */
function booruQuarantineClient({ axios, baseUrl, login, apiKey, timeoutMs = 10000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${login}:${apiKey}`).toString("base64")}`;

  async function page(after, ifNoneMatch) {
    const headers = { Accept: "application/json", Authorization: authorization };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    let r;
    try {
      r = await axios.get(`${base}${PATH}`, {
        params: after === null ? { quarantine: 1 } : { quarantine: 1, after },
        headers,
        timeout: timeoutMs,
        // A redirect to a login page is not an answer.
        maxRedirects: 0,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new Error(`the booru could not be asked for its quarantine document (${err.code || err.message}) -- is it up at ${base}?`);
    }
    if (r.status === 304) {
      if (!ifNoneMatch) throw new Error("the booru answered 304 Not Modified to a quarantine read that sent no If-None-Match");
      return { notModified: true };
    }
    if (r.status === 401 || r.status === 403) {
      // The booru's own sentence names the fix that applies (a Member-level
      // reader is told to have it promoted); ours lists the usual ones.
      const said = r.data && typeof r.data.message === "string" && r.data.message ? `; the booru says: ${r.data.message}` : "";
      throw new Error(`${ACCOUNT_REMEDY} (answered ${r.status}${said})`);
    }
    if (r.status !== 200) throw new Error(`GET ${PATH}?quarantine=1 answered ${r.status}; retried every poll`);
    const d = r.data;
    if (!d || typeof d !== "object" || Array.isArray(d) || typeof d.generation !== "string" || !d.generation || !Array.isArray(d.posts)) {
      throw new Error(OLD_BOORU);
    }
    const next = d.next_after;
    if (!(next === null || (Number.isInteger(next) && next > (after ?? 0)))) {
      throw new Error(`the quarantine document's next_after is ${JSON.stringify(next)}, not null or a post id past ${after ?? 0} -- deploy a chanbooru whose document matches the contract`);
    }
    const bad = d.posts.find((p) => !p || typeof p !== "object" || !isMd5(p.md5) || !(p.mxc === null || p.mxc === undefined || (typeof p.mxc === "string" && p.mxc.startsWith("mxc://"))));
    if (bad !== undefined) {
      throw new Error(`the quarantine document carries a post that is not { md5: <32 hex>, mxc: mxc://... | null } (post ${bad && bad.id}) -- the whole read is refused`);
    }
    return { generation: d.generation, etag: typeof r.headers?.etag === "string" ? r.headers.etag : null, posts: d.posts, next };
  }

  // One pass from page 1: the whole set, or { restart } when the generation
  // moved under it.
  async function pass(ifNoneMatch) {
    const first = await page(null, ifNoneMatch);
    if (first.notModified) return first;
    const md5s = new Set();
    const mxcs = new Set();
    const reviewMd5s = new Set();
    let cur = first;
    for (let n = 1; ; n++) {
      if (cur.generation !== first.generation) return { restart: true };
      cur.posts.forEach((p) => {
        md5s.add(p.md5);
        if (p.mxc) mxcs.add(p.mxc);
        if (p.flagged === true && p.banished !== true && p.jailed !== true && p.mxc) reviewMd5s.add(p.md5);
      });
      if (cur.next === null) return { generation: first.generation, etag: first.etag, md5s, mxcs, reviewMd5s };
      if (n >= MAX_PAGES) throw new Error(`the quarantine document ran past ${MAX_PAGES} pages; refused rather than read partly`);
      cur = await page(cur.next, null);
    }
  }

  return async function fetchDoc({ ifNoneMatch } = {}) {
    for (let attempt = 0; attempt <= MAX_RESTARTS; attempt++) {
      const out = await pass(ifNoneMatch);
      if (!out.restart) return out;
    }
    throw new Error(`the quarantine document's generation changed between pages ${MAX_RESTARTS + 1} times running; retried on the next poll`);
  };
}

/**
 * deps: fetchDoc({ ifNoneMatch }) as above; now(); pollMs; staleMs; log;
 *       problem (quarantineConfigProblem's answer: when set, nothing is polled
 *       and every check throws it); setTimer (setInterval by default).
 */
function createQuarantine({ fetchDoc, now = Date.now, pollMs = 30000, staleMs = STALE_MS, alertMs = ALERT_MS, log = console, problem = null, setTimer = setInterval }) {
  let doc = null; // { generation, etag, md5s, mxcs, reviewMd5s }
  let checkedAt = null;
  let reason = problem || null;
  let alerted = false;
  let inflight = null;
  const graceText = `${Math.round(staleMs / 60_000)} min`;

  async function run() {
    try {
      const out = await fetchDoc({ ifNoneMatch: doc ? doc.etag || undefined : undefined });
      if (!out || !out.notModified) {
        if (!out || typeof out.generation !== "string" || !(out.md5s instanceof Set) || !(out.mxcs instanceof Set) || !(out.reviewMd5s instanceof Set)) {
          throw new Error("the quarantine client returned something that is not a document");
        }
        if (!doc || doc.generation !== out.generation) {
          log.log(`[quarantine] generation ${doc ? doc.generation : "(none)"} -> ${out.generation}: ${out.md5s.size} md5(s), ${out.mxcs.size} Matrix id(s) refused, ${out.reviewMd5s.size} open to a reviewer's booru session`);
        }
        doc = { generation: out.generation, etag: out.etag || null, md5s: out.md5s, mxcs: out.mxcs, reviewMd5s: out.reviewMd5s };
      } else if (!doc) {
        throw new Error("a 304 arrived with no document held");
      }
      checkedAt = now();
      if (reason) log.log(`[quarantine] readable again (generation ${doc.generation})`);
      reason = null;
      alerted = false;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (msg !== reason) {
        log.error(
          `[quarantine] READ FAILED -- ${doc
            ? `keeping generation ${doc.generation} for up to ${graceText} after its last good read, then refusing everything`
            : "no good read yet, so every Matrix picture and publication grant is refused (fail closed)"}: ${msg}`,
        );
      }
      reason = msg;
      if (doc && !alerted && now() - checkedAt > alertMs) {
        alerted = true;
        log.error(`[quarantine] STALE -- ${graceText} grace running: ${graceAlert()}`);
      }
    }
  }

  // The words of the alert while the last good document is still deciding.
  function graceAlert() {
    const age = Math.round((now() - checkedAt) / 1000);
    return `serving on the last good document (generation ${doc.generation}, read ${age}s ago) because the booru has not been read since` +
      `${reason ? `: ${reason}` : ""}. A tag flagged meanwhile takes effect when it returns; at ${graceText} every Matrix picture ` +
      "answers 503 and publication grants are refused. Fix the booru read (BOORU_INTERNAL_URL reachable, the gate account and key, chanbooru deployed).";
  }

  /** One read. Never overlaps another; resolves when it is done. */
  function poll() {
    if (problem) return Promise.resolve();
    if (inflight) return inflight;
    const p = run();
    inflight = p;
    p.finally(() => { if (inflight === p) inflight = null; });
    return p;
  }

  function start() {
    if (problem) {
      log.error(`[quarantine] NOT CONFIGURED -- ${problem}`);
      return api;
    }
    poll();
    const t = setTimer(poll, pollMs);
    if (t && typeof t.unref === "function") t.unref();
    return api;
  }

  function unavailable() {
    if (problem) return problem;
    if (!doc || checkedAt === null) {
      return `the booru's quarantine document has not been read yet: ${reason || "the first read has not finished"}`;
    }
    const age = now() - checkedAt;
    if (age > staleMs) {
      return `the booru's quarantine document was last read ${Math.round(age / 1000)}s ago, past the ${Math.round(staleMs / 1000)}s bound` +
        (reason ? `; the last read failed: ${reason}` : "");
    }
    return null;
  }

  /** "refuse" | "allow". Throws QuarantineUnavailable (fail closed). */
  function check({ md5, mxc } = {}) {
    const why = unavailable();
    if (why) throw new QuarantineUnavailable(why);
    if (md5 && doc.md5s.has(md5)) return "refuse";
    if (mxc && doc.mxcs.has(mxc)) return "refuse";
    return "allow";
  }

  /** Is md5 a FLAGGED Matrix post's file, which the booru door may open to a reviewer? Throws like check(). */
  function reviewable(md5) {
    const why = unavailable();
    if (why) throw new QuarantineUnavailable(why);
    return !!md5 && doc.reviewMd5s.has(md5);
  }

  /**
   * For /healthz. red: check() would throw, OR the booru has not been read for
   * over ALERT_MS (the stale grace is running -- loud from the first minute).
   * amber: the last poll failed, under a minute since the last good read.
   */
  function health() {
    const why = unavailable();
    // By age, not by a failure being on record: a poller that stopped
    // answering at all is as stale as one whose reads fail.
    const grace = !why && now() - checkedAt > alertMs;
    return {
      generation: doc ? doc.generation : null,
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      reason: why || (grace ? graceAlert() : reason),
      grace,
      level: why || grace ? "red" : reason ? "amber" : "green",
    };
  }

  const api = { start, poll, check, reviewable, health };
  return api;
}

/**
 * The Matrix door's question, callable without Express: is this image in the
 * quarantine? The mxc is checked first; the md5s (a list, or a function
 * returning one, called only when the mxc does not already refuse) are every
 * md5 the image's file is known under (mediar2.js localMd5s). Remote media has
 * none. Throws QuarantineUnavailable before any md5 is looked up.
 */
async function matrixDoorVerdict({ quarantine, serverName, mediaId, md5s }) {
  if (quarantine.check({ mxc: `mxc://${serverName}/${mediaId}` }) === "refuse") return "refuse";
  const list = typeof md5s === "function" ? await md5s() : md5s || [];
  return list.some((md5) => quarantine.check({ md5 }) === "refuse") ? "refuse" : "allow";
}

module.exports = {
  booruQuarantineClient,
  createQuarantine,
  QuarantineUnavailable,
  matrixDoorVerdict,
  quarantineConfigProblem,
  MAX_RESTARTS,
  STALE_MS,
  ALERT_MS,
};
