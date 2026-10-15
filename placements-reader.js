"use strict";

// THE PLACEMENTS READER -- gate 3 for posts, piece A2.
//
// fourier-basis docs/design/GATE3_MATRIX_POSTS.md (the rulings) and
// GATE3_CONTRACTS.md A2 (the contract this file is built against). A Matrix
// post on the booru is visible to exactly the viewers its image is visible to.
// The booru cannot ask Synapse which rooms an image is in, so this reader walks
// Synapse's events in stream order and, for every image an event touches,
// PUSHES fourier-auth's own answer for that image -- site asset or not, and its
// rooms -- computed by the image gate's own queries (queryIsSiteAsset,
// queryMediaRooms in mediaauth-sql.js), called directly and never through the
// gate's caches. The booru never unions per-event deltas: each answer REPLACES
// that image's record, so a redaction or a lost forward can land.
//
// The cursor only decides which images to re-ask. Two of them, both kept by
// the booru (operator ruling 2026-10-15: placements are pushed, the booru
// keeps the cursor), asked once at start with
// GET /fourier_jail/release.json?placements=cursor:
//
//   live   from where it stopped to Synapse's head, every 2 s once caught up.
//          With no live cursor at the booru it starts at the head: history is
//          the sweep's job, and lap 1 IS the backfill.
//   sweep  tail to head -- backfilled events have NEGATIVE orderings, so the
//          tail is below zero -- one lap per GATE3_SWEEP_LAP_HOURS (default
//          24), paced across the lap. It catches what leaves no event: a
//          forward that counts once its sender joins an uploader room, a
//          profile avatar, an emote pack.
//
// ONE SNAPSHOT PER PAGE. Each page is one REPEATABLE READ, READ ONLY
// transaction: the head, the touched events, the uploaders and every per-image
// answer describe the same instant, which is what makes "the newer snapshot
// wins" at the booru a correct rule. It runs on this reader's OWN pool (max 2,
// statement_timeout 5 s) so it never competes with the media gate's pool.
//
// PAGING (scale is a requirement: 1,000,000 Matrix posts, GATE3_MATRIX_POSTS.md):
// a window of 50,000 ids, at most 2,000 rows, and a page stops early at 500
// distinct images or 20,000 room entries -- always cut at an event boundary,
// and never before the first image, so every page makes progress.
//
// OUT-OF-ORDER COMMITS (reasoned, not verified): Synapse allocates an ordering
// before it commits, so an event can become visible below a cursor that has
// already passed it. Once caught up, each poll re-reads the 500 ids below the
// cursor and asks again for any event it has not processed; re-asking is
// idempotent, and the sweep backstops whatever this misses.
//
// FAILURES (fail closed, loudly -- memory fail-loudly-no-fallbacks):
//   - Synapse unreadable: the page is abandoned and retried with backoff;
//     nothing is pushed.
//   - A row that fails with a DATA error (SQLSTATE class 22) is bisected down
//     to the one event, which is pushed in `skipped` and shown on /healthz;
//     the rest of the page is pushed (per-item isolation: one unreadable event
//     never stops the reader). An unreadable REDACTION is named apart
//     (unreadable_redaction, unreadable_target): it is a deleted post that may
//     stay visible, where an unreadable image only narrows.
//   - One image whose answer hits the 5 s statement timeout (57014) is asked
//     once more and then skipped as answer_timeout, so one pathological image
//     cannot hold every page behind it forever (review 2026-10-15). Bounded:
//     more than maxAnswerTimeouts in one page is the database, not the image,
//     and abandons the page like any outage.
//   - Every skip turns the lamp amber until the process restarts: a skipped
//     event is an answer the booru does not have, and the sweep meets the same
//     row again every lap. Counted per DISTINCT event, so a lap's repeat is
//     not a new loss (a growing total can hide a loss -- and fake one).
//   - The sweep fails on its own. A sweep page that cannot be read backs the
//     SWEEP off and turns the lamp amber; the live poll carries on at 2 s.
//   - Booru 5xx, 408, 429 or network: back off 5 s doubling to 5 min, cursor
//     unchanged.
//   - Booru 4xx (or a 200 that is not the contract's answer): the reader STOPS
//     and its /healthz lamp is red, naming the fix. A restart retries.
//
// THE BOORU'S CURSOR IS RE-READ ON EVERY PUSH. The reader moves its own
// position in memory, but every push answer carries the booru's cursor, and a
// live push goes at least once a minute (the heartbeat), so the two are
// compared at least that often (memory stale-index-check-then-act). They should
// be equal: the booru advances to the page's `to`. Unequal -- a second reader,
// a restored booru or Synapse, a booru that did not take a lap's restart -- is
// amber with both values named, and is NOT adopted: a booru behind would make
// the reader re-read one range forever, and a booru ahead may hold a cursor
// from another Synapse. Likewise `stale`: one reader's snapshots only ever get
// newer, so a stale answer means someone else is writing (or a restored
// Synapse's head went back) and is amber for five minutes after the last one.
//
// /healthz: a caller without detail access (callers.js, leak audit F-G5) sees
// the level, a fixed phrase and the skipped counts. Cursors, Synapse's head,
// the lag, the newest placement and the sweep's position are detail only --
// sampled twice they say when, and how often, images are posted across every
// room, private ones included.
//
// Off unless GATE3_READER=on. Any other value is a configuration error, said
// at boot and on /healthz, never read as off.

const { makeQueries } = require("./mediaauth-sql");

const PATH = "/fourier_jail/release.json";
const LABEL = "gate 3 placements reader (Synapse events -> booru)";

const DEFAULTS = {
  pollMs: 2000,
  windowIds: 50000,
  rowLimit: 2000,
  maxMxcs: 500,
  maxRoomEntries: 20000,
  tailReread: 500,
  lapHours: 24,
  backoffMinMs: 5000,
  backoffMaxMs: 5 * 60_000,
  // An empty page is pushed at most this often (its only effect is to move the
  // booru's cursor); a page with images or skipped events is always pushed.
  heartbeatMs: 60_000,
  lagRedMs: 5 * 60_000,
  recentSkipped: 20,
  // Distinct skipped events remembered (by event id); past this the count of
  // further distinct ones is kept, not their ids.
  maxDistinctSkipped: 1000,
  // Images in one page allowed to be skipped for a statement timeout before
  // the page is the database's problem rather than those images'.
  maxAnswerTimeouts: 3,
};

// The fix for a reader whose account or key the booru refuses.
const ACCOUNT_FIX =
  "BOORU_PLACEMENTS_LOGIN / BOORU_PLACEMENTS_API_KEY in fourier-auth's .env must be the booru's gate account and " +
  "a key of it permitted fourier_jail:create and fourier_jail:index; correct them and restart fourier-auth";
const OLD_BOORU =
  "the booru does not take gate 3 placements (GATE3_CONTRACTS.md A2, D) -- deploy chanbooru with the placements mode, then restart fourier-auth";

// Back off and retry: the cursor does not move.
class PushRetryable extends Error {
  constructor(message) { super(message); this.name = "PushRetryable"; }
}
// Stop, red, with the fix in the message.
class PushRejected extends Error {
  constructor(message) { super(message); this.name = "PushRejected"; }
}

// GATE3_READER: unset or "off" is off; "on" is on; anything else is an error
// that keeps it off AND red, so a typo never reads as a decision.
function parseReaderConfig(env) {
  const raw = env.GATE3_READER === undefined ? "" : String(env.GATE3_READER).trim();
  if (raw === "" || raw === "off") return { on: false, problem: null };
  if (raw !== "on") {
    return { on: false, problem: `GATE3_READER is "${raw}"; it is on or off (unset is off). Set it in fourier-auth's docker-compose.yaml environment and recreate the container.` };
  }
  const problems = [];
  const login = String(env.BOORU_PLACEMENTS_LOGIN || "");
  const apiKey = String(env.BOORU_PLACEMENTS_API_KEY || "");
  if (!login) problems.push("BOORU_PLACEMENTS_LOGIN is unset");
  if (!apiKey) problems.push("BOORU_PLACEMENTS_API_KEY is unset");
  let lapHours = DEFAULTS.lapHours;
  if (env.GATE3_SWEEP_LAP_HOURS !== undefined && String(env.GATE3_SWEEP_LAP_HOURS).trim() !== "") {
    lapHours = Number(env.GATE3_SWEEP_LAP_HOURS);
    if (!(Number.isFinite(lapHours) && lapHours > 0)) problems.push(`GATE3_SWEEP_LAP_HOURS "${env.GATE3_SWEEP_LAP_HOURS}" is not a positive number of hours`);
  }
  if (problems.length) {
    return {
      on: true,
      problem: `${problems.join("; ")}. The reader pushes as the booru's gate account (BOORU_PLACEMENTS_LOGIN, ` +
        "BOORU_PLACEMENTS_API_KEY in the gitignored .env, the key entered with read -s; permitted fourier_jail:create " +
        "and fourier_jail:index); GATE3_SWEEP_LAP_HOURS is optional. Nothing is pushed until they are set.",
    };
  }
  return { on: true, problem: null, login, apiKey, lapHours };
}

const isSafeInt = (v) => Number.isSafeInteger(v);
// The cursor's three fields are integers or null; lap_started_at is epoch
// milliseconds (GATE3_CONTRACTS.md A2 leaves its type open -- this is the
// reading the reader holds the booru to, and says so when refused).
const CURSOR_SHAPE = '{"cursor":{"live":int|null,"sweep":int|null,"lap_started_at":epoch-ms int|null}}';
const nullOrInt = (v) => v === null || v === undefined || isSafeInt(v);

function validCursor(c) {
  return !!c && typeof c === "object" && !Array.isArray(c) &&
    nullOrInt(c.live) && nullOrInt(c.sweep) && nullOrInt(c.lap_started_at);
}
const normCursor = (c) => ({ live: c.live ?? null, sweep: c.sweep ?? null, lap_started_at: c.lap_started_at ?? null });

/**
 * The booru, as this reader uses it: { getCursor(), push(body) }. Basic auth
 * as the gate account -- never a key in a URL (the booru's api_key is a query
 * parameter only when someone puts it there). Throws PushRetryable or
 * PushRejected; returns only answers that match the contract.
 */
function placementsBooruClient({ axios, baseUrl, login, apiKey, timeoutMs = 15000 }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${login}:${apiKey}`).toString("base64")}`;

  async function call(method, params, data) {
    let r;
    try {
      r = await axios.request({
        method,
        url: `${base}${PATH}`,
        params,
        data,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization },
        timeout: timeoutMs,
        // A redirect to a login page is not an answer.
        maxRedirects: 0,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new PushRetryable(`the booru could not be reached at ${base} (${err.code || err.message}); retried with backoff, the cursor does not move`);
    }
    const said = r.data && typeof r.data === "object" && typeof r.data.message === "string" && r.data.message ? `; the booru says: ${r.data.message}` : "";
    if (r.status >= 500 || r.status === 408 || r.status === 429) {
      throw new PushRetryable(`${method.toUpperCase()} ${PATH} answered ${r.status}${said}; retried with backoff, the cursor does not move`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new PushRejected(`${method.toUpperCase()} ${PATH} answered ${r.status}${said}. ${ACCOUNT_FIX}`);
    }
    if (r.status !== 200) {
      throw new PushRejected(`${method.toUpperCase()} ${PATH} answered ${r.status}${said}. ${OLD_BOORU}`);
    }
    return r.data;
  }

  async function getCursor() {
    const d = await call("get", { placements: "cursor" });
    if (!d || typeof d !== "object" || !validCursor(d.cursor)) {
      throw new PushRejected(`GET ${PATH}?placements=cursor did not answer ${CURSOR_SHAPE}. ${OLD_BOORU}`);
    }
    return normCursor(d.cursor);
  }

  async function push(body) {
    const d = await call("post", undefined, body);
    if (!d || typeof d !== "object" || !validCursor(d.cursor) || !isSafeInt(d.applied) || !isSafeInt(d.stale)) {
      throw new PushRejected(`POST ${PATH} {"placements":...} did not answer ${CURSOR_SHAPE.slice(0, -1)},"applied":int,"stale":int}. ${OLD_BOORU}`);
    }
    return { cursor: normCursor(d.cursor), applied: d.applied, stale: d.stale };
  }

  return { getCursor, push };
}

// A pool of its own (GATE3_CONTRACTS.md A2): two connections, five seconds a
// statement, so the reader can never take the media gate's connections or
// hold one through a pathological plan.
function readerPool(env, { Pool = require("pg").Pool, log = console } = {}) {
  const pool = new Pool({
    host: env.SYNAPSE_DB_HOST,
    port: parseInt(env.SYNAPSE_DB_PORT || "5432", 10),
    database: env.SYNAPSE_DB_NAME,
    user: env.SYNAPSE_DB_USER,
    password: env.SYNAPSE_DB_PASSWORD,
    max: 2,
    statement_timeout: 5000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: "fourier-auth-gate3-reader",
  });
  pool.on("error", (err) => log.error("[gate3-reader] pg pool error:", err.code || err.message));
  return pool;
}

// withSnapshot(fn): run fn(q) inside one REPEATABLE READ READ ONLY transaction
// on one connection, q being mediaauth-sql.js's queries on that connection plus
// q.attempt(f), which runs f under a savepoint so a failed statement can be
// isolated without losing the snapshot (bisection needs exactly that).
function snapshotRunner(pool, { homeserverName }) {
  return async function withSnapshot(fn) {
    const client = await pool.connect();
    let done = false;
    try {
      await client.query("begin isolation level repeatable read read only");
      let n = 0;
      const q = makeQueries(client, { homeserverName });
      q.attempt = async (f) => {
        const sp = `gate3_${++n}`;
        await client.query(`savepoint ${sp}`);
        try {
          const v = await f();
          await client.query(`release savepoint ${sp}`);
          return v;
        } catch (err) {
          await client.query(`rollback to savepoint ${sp}`);
          throw err;
        }
      };
      const out = await fn(q);
      await client.query("commit");
      done = true;
      return out;
    } finally {
      if (!done) await client.query("rollback").catch(() => {});
      // A connection that saw an error is discarded rather than reused.
      client.release(done ? undefined : true);
    }
  };
}

// A data error (SQLSTATE class 22: invalid JSON text, a bad cast) is about one
// ROW and is bisected. Anything else -- a refused connection, a timeout, a
// missing grant -- is about the database and abandons the page.
const isDataError = (err) => !!err && typeof err.code === "string" && err.code.startsWith("22");
// query_canceled: the reader pool's 5 s statement_timeout fired.
const isTimeout = (err) => !!err && err.code === "57014";
// A skip that may leave a DELETED post visible, as against an image the booru
// merely does not know yet.
const isRedactionSkip = (reason) => /^unreadable_(redaction|target):/.test(reason);

const MXC_RE = /^mxc:\/\/([^/\s]+)\/([A-Za-z0-9_-]+)$/;
function parseMxc(url) {
  if (typeof url !== "string") return null;
  const m = MXC_RE.exec(url);
  return m ? { serverName: m[1], mediaId: m[2] } : null;
}

// onLiveAnswers(mxcs): called with every image a LIVE page answered, before
// the push, so the image gate can forget what it cached about them (index.js
// drops mediaauth-core.js mediaFactKeys). A redaction then reaches the IMAGE
// within one poll, not when a six-hour cache entry expires; that is what
// "deleting a message hides its image at once" (ruled 2026-10-15) needs. Live
// only: a redaction always has an event, and the sweep's job is what has none.
function createPlacementsReader({ withSnapshot, booru, homeserverName, onLiveAnswers = null, now = () => Date.now(), setTimer = setTimeout, log = console, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const lapMs = o.lapHours * 3600_000;

  const st = {
    phase: "starting", // starting | running | backoff | stopped
    stoppedReason: null,
    lastError: null,
    live: null,        // read through this ordering (the next page's exclusive lower bound)
    caughtUp: false,
    head: null,
    tail: null,
    lagIds: null,
    lagSeconds: null,
    lastCycleAt: null, // the last cycle that completed (read AND, if needed, pushed)
    startedAt: now(),
    sweep: null,       // { pos, lapTail, lapHead, lapStartedAt, laps }
    lastPush: null,
    lastPushAt: { live: -Infinity, sweep: -Infinity },
    newest: null,      // { ordering, at }
    skippedTotal: 0,   // occurrences: the sweep meets the same row every lap
    skipped: new Map(), // event_id -> { stream_ordering, event_id, reason, first_at, last_at, times }, newest last
    skippedUnlisted: 0, // distinct skips past maxDistinctSkipped
    disagree: { live: null, sweep: null }, // { booru, reader, at } when the booru's cursor is not the page's end
    staleTotal: 0,
    lastStaleAt: null,
    sweepBackoffMs: 0,
    sweepRetryAt: 0,
    sweepError: null,
    backoffMs: 0,
    seen: new Set(),   // live orderings already processed, within tailReread of the cursor
    timer: null,
  };

  // Rows of (from, to], at most `limit`, bisecting a data error down to the
  // one ordering that causes it, which goes to `skipped`.
  async function readRows(q, from, to, limit, skipped) {
    if (to <= from || limit <= 0) return [];
    try {
      return await q.attempt(() => q.queryTouchPage(from, to, limit));
    } catch (err) {
      if (!isDataError(err)) throw err;
      if (to - from === 1) {
        let at = null;
        try { at = await q.attempt(() => q.queryEventAt(to)); } catch (e) { if (!isDataError(e)) throw e; }
        // An ordering with no event cannot fail a read; seeing one here means
        // the error was not this row's after all, so it is the database's.
        if (at === null) throw err;
        const what = at.type === "m.room.redaction" ? "unreadable_redaction" : "unreadable_event";
        skipped.push({ stream_ordering: to, event_id: at.event_id, reason: `${what}:${err.code}` });
        return [];
      }
      const mid = from + Math.floor((to - from) / 2);
      const left = await readRows(q, from, mid, limit, skipped);
      if (left.length >= limit) return left;
      return left.concat(await readRows(q, mid, to, limit - left.length, skipped));
    }
  }

  // The url each redaction took away, by target event id. A target whose JSON
  // cannot be read is isolated the same way a row is.
  async function readTargets(q, rows, skipped) {
    const reds = rows.filter((r) => r.type === "m.room.redaction" && typeof r.redacts === "string");
    const ids = [...new Set(reds.map((r) => r.redacts))];
    if (ids.length === 0) return new Map();
    try {
      return await q.attempt(() => q.queryRedactionTargets(ids));
    } catch (err) {
      if (!isDataError(err)) throw err;
      const out = new Map();
      for (const id of ids) {
        try {
          const one = await q.attempt(() => q.queryRedactionTargets([id]));
          if (one.has(id)) out.set(id, one.get(id));
        } catch (e) {
          if (!isDataError(e)) throw e;
          for (const r of reds) {
            if (r.redacts === id) skipped.push({ stream_ordering: r.stream_ordering, event_id: r.event_id, reason: `unreadable_target:${e.code}` });
          }
        }
      }
      return out;
    }
  }

  /**
   * One page: the events in (from, to] (plus `late` rows below `from`), the
   * images they touch, and the answer for each. Returns { placements, end,
   * processed } where end is where the page was cut and processed lists every
   * ordering it accounted for.
   */
  async function buildPage(q, { stream, from, to, snapshot, lap = null, late = [], lateSkipped = [] }) {
    const skipped = [...lateSkipped];
    const pageRows = await readRows(q, from, to, o.rowLimit, skipped);
    let end = pageRows.length >= o.rowLimit ? pageRows[pageRows.length - 1].stream_ordering : to;
    const rows = late.concat(pageRows);
    const targets = await readTargets(q, rows, skipped);

    const touches = [];
    for (const r of rows) {
      const url = r.type === "m.room.redaction" ? (typeof r.redacts === "string" ? targets.get(r.redacts) : null) : r.url;
      const m = parseMxc(url);
      // Remote media is skipped silently: the tunnel posts local media only.
      if (!m || m.serverName !== homeserverName) continue;
      touches.push({ ordering: r.stream_ordering, eventId: r.event_id, mxc: url, mediaId: m.mediaId });
    }

    // Cut at maxMxcs distinct images, at an event boundary.
    const first = new Map(); // mxc -> index of its first touch
    let cut = touches.length;
    for (let i = 0; i < touches.length; i++) {
      if (first.has(touches[i].mxc)) continue;
      if (first.size >= o.maxMxcs) { cut = i; break; }
      first.set(touches[i].mxc, i);
    }
    const cutBefore = (i) => { cut = i; end = Math.max(from, touches[i].ordering - 1); };
    if (cut < touches.length) cutBefore(cut);

    const mediaIds = [...new Set([...first.keys()].map((mxc) => parseMxc(mxc).mediaId))];
    const uploaders = mediaIds.length ? await q.attempt(() => q.queryUploaders(mediaIds)) : new Map();

    const answers = [];
    let roomEntries = 0;
    let timeouts = 0;
    const answer = async (mxc, uploader) => {
      const siteAsset = await q.attempt(() => q.queryIsSiteAsset(mxc, uploader, homeserverName));
      const rooms = [...(await q.attempt(() => q.queryMediaRooms(mxc, uploader)))].sort();
      return { mxc, uploader, site_asset: siteAsset === true, rooms };
    };
    for (const [mxc, firstIdx] of first) {
      if (firstIdx >= cut) break;
      const uploader = uploaders.get(parseMxc(mxc).mediaId) ?? null;
      let a;
      try {
        a = await answer(mxc, uploader);
      } catch (err) {
        let failed = err;
        // A timeout may be the moment (a vacuum, a cold cache): once more,
        // then it is this image's. The savepoint kept the snapshot.
        if (isTimeout(err)) {
          try { a = await answer(mxc, uploader); failed = null; } catch (again) { failed = again; }
        }
        if (failed) {
          let reason;
          if (isDataError(failed)) reason = `answer_failed:${failed.code}`;
          else if (isTimeout(failed) && ++timeouts <= o.maxAnswerTimeouts) reason = "answer_timeout";
          else throw failed;
          for (let i = firstIdx; i < cut; i++) {
            if (touches[i].mxc === mxc) skipped.push({ stream_ordering: touches[i].ordering, event_id: touches[i].eventId, reason });
          }
          continue;
        }
      }
      if (answers.length > 0 && roomEntries + a.rooms.length > o.maxRoomEntries) { cutBefore(firstIdx); break; }
      roomEntries += a.rooms.length;
      answers.push(a);
    }

    const kept = touches.slice(0, cut);
    // Touches are in ascending ordering (late rows sit below `from`), so the
    // cut is also an ordering: nothing at or past it was answered, and nothing
    // at or past it may be marked processed -- including late rows, which the
    // tail re-read must find again.
    const cutOrdering = cut < touches.length ? touches[cut].ordering : Infinity;
    const mxcs = answers.map((a) => ({
      ...a,
      newest_ordering: Math.max(...kept.filter((t) => t.mxc === a.mxc).map((t) => t.ordering)),
    }));
    const inPage = (ord) => ord <= end;
    // A sweep page names its LAP (the lap's start, epoch ms). The booru resets
    // its sweep cursor when the lap is newer and only advances it within a
    // lap; without the marker a booru that only moves cursors upward kept the
    // old lap's end, and a reader restarted mid-lap never finished one
    // (GATE3_CONTRACTS.md A2).
    const placements = {
      stream,
      ...(stream === "sweep" ? { lap } : {}),
      from,
      to: end,
      snapshot,
      mxcs,
      skipped: skipped.filter((s) => inPage(s.stream_ordering)),
    };
    const processed = rows.map((r) => r.stream_ordering).filter((ord) => ord < cutOrdering && inPage(ord))
      .concat(placements.skipped.map((s) => s.stream_ordering));
    return { placements, end, processed };
  }

  // Skips by DISTINCT event: the sweep reads the same unreadable row every
  // lap, and an occurrence count that grows by one a day says nothing about
  // whether anything new was lost.
  function noteSkipped(list) {
    const at = new Date(now()).toISOString();
    for (const s of list) {
      st.skippedTotal++;
      const prev = st.skipped.get(s.event_id);
      if (prev) {
        st.skipped.delete(s.event_id);
        st.skipped.set(s.event_id, { ...prev, reason: s.reason, last_at: at, times: prev.times + 1 });
        log.error(`[gate3-reader] SKIPPED AGAIN event ${s.event_id} at stream_ordering ${s.stream_ordering} (${s.reason}, ${prev.times + 1} times since ${prev.first_at}); still unreadable`);
        continue;
      }
      if (st.skipped.size < o.maxDistinctSkipped) {
        st.skipped.set(s.event_id, { stream_ordering: s.stream_ordering, event_id: s.event_id, reason: s.reason, first_at: at, last_at: at, times: 1 });
      } else {
        st.skippedUnlisted++;
      }
      log.error(`[gate3-reader] SKIPPED event ${s.event_id} at stream_ordering ${s.stream_ordering} (${s.reason}); the rest of its page was pushed. ` +
        (isRedactionSkip(s.reason) ? "A redaction: the post it deleted may stay visible. " : "") +
        "Read the row in Synapse's events/event_json to see why it cannot be read");
    }
  }

  // The booru's answer to a push, against what the push said: its cursor for
  // this stream should now be the page's end, and nothing should be stale.
  function noteAnswer(placements, ans) {
    const stream = placements.stream;
    const booruAt = ans.cursor[stream];
    const was = st.disagree[stream];
    if (booruAt === placements.to) {
      if (was) log.log(`[gate3-reader] the booru's ${stream} cursor agrees again at ${booruAt}`);
      st.disagree[stream] = null;
    } else {
      st.disagree[stream] = { booru: booruAt, reader: placements.to, at: new Date(now()).toISOString() };
      if (!was) {
        const why = stream === "sweep" && booruAt !== null && booruAt > placements.to
          ? "the booru did not reset its sweep cursor for this push's newer lap, so a restart resumes at its old cursor and this lap starts again (GATE3_CONTRACTS.md A2: a sweep push whose lap is newer than the stored lap_started_at resets the cursor)"
          : booruAt !== null && booruAt > placements.to
            ? "the booru holds a cursor this reader never pushed: a second reader, or a booru or Synapse restored from another time"
            : "the booru did not advance to the page this reader pushed";
        log.error(`[gate3-reader] the booru answered ${stream} cursor ${booruAt} after a push ending at ${placements.to}: ${why}. ` +
          "The reader keeps its own position; check that one fourier-auth runs GATE3_READER=on and that the booru stores the cursor");
      }
    }
    if (ans.stale > 0) {
      st.staleTotal += ans.stale;
      st.lastStaleAt = now();
      log.error(`[gate3-reader] the booru held a NEWER answer for ${ans.stale} of ${placements.mxcs.length} image(s) in a ${stream} push: ` +
        "another writer is pushing placements, or Synapse's head went back (a restore). One reader's snapshots only get newer");
    }
  }

  // Push a page when it carries anything, or as a heartbeat; record the result.
  async function maybePush(placements, { force = false } = {}) {
    const stream = placements.stream;
    const empty = placements.mxcs.length === 0 && placements.skipped.length === 0;
    if (empty && !force && now() - st.lastPushAt[stream] < o.heartbeatMs) return null;
    const at = now();
    try {
      const ans = await booru.push({ placements });
      st.lastPush = { at: new Date(at).toISOString(), stream, from: placements.from, to: placements.to, ok: true, mxcs: placements.mxcs.length, skipped: placements.skipped.length, applied: ans.applied, stale: ans.stale };
      st.lastPushAt[stream] = at;
      noteAnswer(placements, ans);
      for (const m of placements.mxcs) {
        if (!st.newest || m.newest_ordering > st.newest.ordering) st.newest = { ordering: m.newest_ordering, at: new Date(at).toISOString() };
      }
      noteSkipped(placements.skipped);
      return ans;
    } catch (err) {
      st.lastPush = { at: new Date(at).toISOString(), stream, from: placements.from, to: placements.to, ok: false, error: err.message };
      throw err;
    }
  }

  async function begin() {
    const cursor = await booru.getCursor();
    const b = await withSnapshot((q) => q.queryStreamBounds());
    st.head = b.head;
    st.tail = b.tail;
    if (cursor.live === null) {
      st.live = b.head;
      log.log(`[gate3-reader] the booru holds no live cursor: starting at Synapse's head ${b.head}; history is the sweep's (lap 1 is the backfill)`);
    } else {
      st.live = cursor.live;
      if (cursor.live > b.head) log.error(`[gate3-reader] the booru's live cursor ${cursor.live} is AHEAD of Synapse's head ${b.head}: events below it will not be read live until the head passes it; the sweep still covers them. Was Synapse's database restored?`);
    }
    st.sweep = cursor.sweep === null ? null : {
      pos: cursor.sweep,
      lapTail: b.tail - 1,
      lapHead: b.head,
      lapStartedAt: cursor.lap_started_at ?? now(),
      laps: 0,
    };
    st.phase = "running";
    log.log(`[gate3-reader] running: live from ${st.live}, sweep ${st.sweep ? `at ${st.sweep.pos}` : "starting a lap"}, Synapse ${b.tail}..${b.head}`);
  }

  async function liveOnce() {
    const from = st.live;
    const caughtUpBefore = st.caughtUp;
    const out = await withSnapshot(async (q) => {
      const b = await q.queryStreamBounds();
      const snapshot = { head: b.head, at: b.at };
      const to = Math.min(b.head, from + o.windowIds);
      let late = [];
      let lateSkipped = [];
      if (caughtUpBefore) {
        const sk = [];
        const rows = await readRows(q, from - o.tailReread, from, o.rowLimit, sk);
        late = rows.filter((r) => !st.seen.has(r.stream_ordering));
        lateSkipped = sk.filter((s) => !st.seen.has(s.stream_ordering));
      }
      if (to <= from && late.length === 0 && lateSkipped.length === 0) {
        return { b, page: null };
      }
      const page = await buildPage(q, { stream: "live", from, to: Math.max(to, from), snapshot, late, lateSkipped });
      const received = page.end < b.head ? await q.queryFirstReceivedAfter(page.end) : null;
      return { b, page, received };
    });
    const { b, page } = out;
    st.head = b.head;
    st.tail = b.tail;
    const end = page ? page.end : from;
    st.lagIds = Math.max(0, b.head - end);
    st.lagSeconds = end >= b.head ? 0 : out.received ? Math.max(0, Math.round((b.at - out.received) / 1000)) : null;
    if (page && onLiveAnswers && page.placements.mxcs.length) {
      try {
        await onLiveAnswers(page.placements.mxcs.map((m) => m.mxc));
      } catch (err) {
        log.error(`[gate3-reader] could not clear the image gate's cached facts for ${page.placements.mxcs.length} image(s) ` +
          `(${err.code || err.message}): a redaction among them reaches the image when its cache entry expires (up to 6 h), ` +
          "not at once. Check fourier-redis; the push goes ahead.");
      }
    }
    if (page) {
      await maybePush(page.placements);
      for (const ord of page.processed) st.seen.add(ord);
    }
    st.live = end;
    st.caughtUp = end >= b.head;
    for (const ord of st.seen) if (ord <= st.live - o.tailReread) st.seen.delete(ord);
  }

  // When the next sweep page may start: proportional to how far through the
  // lap it is, so a lap takes lapMs however many pages it has.
  function sweepDueAt() {
    const s = st.sweep;
    if (!s) return 0;
    if (s.pos >= s.lapHead) return s.lapStartedAt + lapMs;
    const span = Math.max(1, s.lapHead - s.lapTail);
    return s.lapStartedAt + Math.floor(lapMs * (s.pos - s.lapTail) / span);
  }

  async function sweepOnce() {
    const out = await withSnapshot(async (q) => {
      const b = await q.queryStreamBounds();
      let s = st.sweep;
      if (!s || s.pos >= s.lapHead) {
        s = { pos: b.tail - 1, lapTail: b.tail - 1, lapHead: b.head, lapStartedAt: now(), laps: s ? s.laps : 0, fresh: true };
      }
      const to = Math.min(s.lapHead, s.pos + o.windowIds);
      const page = await buildPage(q, { stream: "sweep", from: s.pos, to, snapshot: { head: b.head, at: b.at }, lap: s.lapStartedAt });
      return { s, page };
    });
    const { s, page } = out;
    const lapEnds = page.end >= s.lapHead;
    await maybePush(page.placements, { force: lapEnds || s.fresh === true });
    if (s.fresh) log.log(`[gate3-reader] sweep lap ${s.laps + 1} started: ${s.lapTail}..${s.lapHead} over ${o.lapHours} h`);
    st.sweep = { pos: page.end, lapTail: s.lapTail, lapHead: s.lapHead, lapStartedAt: s.lapStartedAt, laps: s.laps + (lapEnds ? 1 : 0) };
    if (lapEnds) log.log(`[gate3-reader] sweep lap ${st.sweep.laps} done at ${page.end}`);
  }

  function stop(err) {
    st.phase = "stopped";
    st.stoppedReason = err.message;
    log.error(`[gate3-reader] STOPPED -- nothing more is pushed until fourier-auth restarts: ${err.message}`);
    return null;
  }
  const describe = (err, what) => err instanceof PushRetryable ? err.message
    : `Synapse's database could not be read for the ${what} page (${err.code || err.message}); nothing was pushed. Check the synapse-postgres container and SYNAPSE_DB_*`;

  /**
   * One cycle: start if needed, the live page, then a sweep page when due.
   * Resolves to the delay before the next. The sweep has its OWN backoff: a
   * sweep page that cannot be read must not stall the live poll, or a single
   * bad stretch of history would hold every new post (and every redaction)
   * back with it.
   */
  async function step() {
    if (st.phase === "stopped") return null;
    try {
      if (st.live === null) await begin();
      await liveOnce();
    } catch (err) {
      if (err instanceof PushRejected) return stop(err);
      st.backoffMs = st.backoffMs ? Math.min(st.backoffMs * 2, o.backoffMaxMs) : o.backoffMinMs;
      st.phase = "backoff";
      const what = describe(err, "live");
      if (what !== st.lastError) log.error(`[gate3-reader] retrying in ${Math.round(st.backoffMs / 1000)} s: ${what}`);
      st.lastError = what;
      return st.backoffMs;
    }
    if (st.phase === "backoff") log.log("[gate3-reader] recovered; reading again");
    st.phase = "running";
    st.backoffMs = 0;
    st.lastError = null;
    st.lastCycleAt = now();
    if (st.caughtUp && now() >= sweepDueAt() && now() >= st.sweepRetryAt) {
      try {
        await sweepOnce();
        if (st.sweepError) log.log("[gate3-reader] the sweep recovered");
        st.sweepBackoffMs = 0;
        st.sweepRetryAt = 0;
        st.sweepError = null;
      } catch (err) {
        if (err instanceof PushRejected) return stop(err);
        st.sweepBackoffMs = st.sweepBackoffMs ? Math.min(st.sweepBackoffMs * 2, o.backoffMaxMs) : o.backoffMinMs;
        st.sweepRetryAt = now() + st.sweepBackoffMs;
        const what = describe(err, "sweep");
        if (what !== st.sweepError) log.error(`[gate3-reader] sweep retrying in ${Math.round(st.sweepBackoffMs / 1000)} s (the live poll carries on): ${what}`);
        st.sweepError = what;
      }
    }
    return st.caughtUp ? o.pollMs : 0;
  }

  function start() {
    const loop = async () => {
      const next = await step();
      if (next === null) return;
      st.timer = setTimer(loop, next);
      if (st.timer && typeof st.timer.unref === "function") st.timer.unref();
    };
    loop();
    return api;
  }

  /**
   * The gate3-reader /healthz check. detail: the caller may see positions,
   * error text and event ids (callers.js, leak audit F-G5); without it, the
   * level, a fixed phrase and the skipped counts only.
   */
  function health({ detail = false } = {}) {
    const sinceCycle = st.lastCycleAt === null ? now() - st.startedAt : now() - st.lastCycleAt;
    const lagMs = st.lagSeconds === null ? 0 : st.lagSeconds * 1000;
    const stuck = sinceCycle > o.lagRedMs;
    const lagging = lagMs > o.lagRedMs;
    const ahead = st.live !== null && st.head !== null && st.live > st.head;
    const staleRecent = st.lastStaleAt !== null && now() - st.lastStaleAt <= o.lagRedMs;
    const distinct = st.skipped.size + st.skippedUnlisted;
    const redactions = [...st.skipped.values()].filter((x) => isRedactionSkip(x.reason)).length;
    // Amber: running, but something is owed -- an answer the booru lacks, a
    // cursor the booru does not share, a writer it should not have, a sweep
    // that cannot read.
    const owed = [];
    if (distinct) owed.push(`${distinct} event(s) skipped${redactions ? `, ${redactions} of them redactions (a deleted post may stay visible)` : ""}`);
    if (st.disagree.live || st.disagree.sweep) owed.push("the booru's cursor disagrees with the reader's");
    if (staleRecent) owed.push("the booru answered stale: another writer, or Synapse went back");
    if (ahead) owed.push("the booru's live cursor is ahead of Synapse's head");
    if (st.sweepError) owed.push("the sweep is retrying");
    const level = st.phase === "stopped" || lagging || stuck ? "red"
      : st.phase === "backoff" || st.lastCycleAt === null || owed.length ? "amber" : "green";
    const sweepPct = st.sweep && st.sweep.lapHead > st.sweep.lapTail
      ? Math.min(100, Math.round(100 * (st.sweep.pos - st.sweep.lapTail) / (st.sweep.lapHead - st.sweep.lapTail))) : null;
    const counts = { count: st.skippedTotal, distinct, redactions };

    if (!detail) {
      const said = st.phase === "stopped" ? "STOPPED: see the service log"
        : stuck ? "no cycle has completed for over 5 minutes; see the service log"
        : st.phase === "backoff" ? "retrying; see the service log"
        : st.lastCycleAt === null ? "starting"
        : (lagging ? "running, lag over 5 minutes" : "running") + (owed.length ? `; ${owed.join("; ")}; see the service log` : "");
      return { id: "gate3-reader", label: LABEL, level, detail: said, skipped: counts };
    }

    const said = st.phase === "stopped" ? `STOPPED: ${st.stoppedReason}`
      : stuck ? `no cycle has completed for ${Math.round(sinceCycle / 1000)} s${st.lastError ? `: ${st.lastError}` : ""}`
      : st.phase === "backoff" ? `retrying${st.lastError ? `: ${st.lastError}` : ""}`
      : st.lastCycleAt === null ? "starting: the booru's cursor and Synapse's head have not been read yet"
      : `live ${st.live} of ${st.head} (lag ${st.lagIds} ids, ${st.lagSeconds ?? "?"} s)` +
        (st.sweep ? `; sweep lap ${st.sweep.laps + 1} at ${sweepPct ?? 100}%` : "; sweep not started") +
        `; ${st.skippedTotal} skipped (${distinct} distinct)` +
        (owed.length ? `; ${owed.join("; ")}` : "") +
        (st.sweepError ? `; sweep: ${st.sweepError}` : "");
    return {
      id: "gate3-reader",
      label: LABEL,
      level,
      detail: said,
      live_cursor: st.live,
      synapse_head: st.head,
      lag_ids: st.lagIds,
      lag_seconds: st.lagSeconds,
      newest_pushed: st.newest,
      sweep: st.sweep ? { position: st.sweep.pos, lap: st.sweep.laps + 1, lap_started_at: new Date(st.sweep.lapStartedAt).toISOString(), lap_tail: st.sweep.lapTail, lap_head: st.sweep.lapHead, percent: sweepPct, retrying: st.sweepError } : null,
      last_push: st.lastPush,
      booru_cursor_disagrees: { live: st.disagree.live, sweep: st.disagree.sweep },
      stale: { total: st.staleTotal, last_at: st.lastStaleAt === null ? null : new Date(st.lastStaleAt).toISOString() },
      skipped: { ...counts, unlisted: st.skippedUnlisted, recent: [...st.skipped.values()].slice(-o.recentSkipped) },
    };
  }

  const api = { start, step, health, state: () => st };
  return api;
}

// The /healthz check when the reader is off or misconfigured.
function readerOffHealth(config) {
  if (config.problem) {
    return { id: "gate3-reader", label: LABEL, level: "red", detail: `NOT RUNNING: ${config.problem}` };
  }
  return { id: "gate3-reader", label: LABEL, level: "green", detail: "off (GATE3_READER is not on): no placements are pushed" };
}

module.exports = {
  createPlacementsReader,
  placementsBooruClient,
  parseReaderConfig,
  readerPool,
  snapshotRunner,
  readerOffHealth,
  isDataError,
  parseMxc,
  PushRetryable,
  PushRejected,
  DEFAULTS,
  PATH,
};
