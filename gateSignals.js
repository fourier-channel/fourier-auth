"use strict";

// THE LAMP FOR THE THING THAT WENT WRONG.
//
// For weeks the media gate refused pictures to readers who held a perfectly
// live booru session, and nothing anywhere went red: the session bar read the
// Redis TTL, the plane probed /healthz and got {status: "ok"} because Redis
// answered PONG, and the refusals were only visible to someone reading the
// masked access log by hand (operator, 2026-09-19: "this is where the lamp is
// supposed to turn red").
//
// So the gate now counts the three things that mean "a signed-in reader is
// being refused", over a sliding ten minutes, and /healthz reports them in the
// health-document shape the plane reads (level + checks). The counts are
// facts about answers already given, never about the request in flight:
// recording one cannot change an answer or fail a request.
//
//   session_refusals  a request that presented a fourier_session cookie and
//                     was answered 401 or 403 by the media gate
//   stale_unrenewable a session handed out with a token past its life and no
//                     refresh token to renew it
//   refresh_failures  a refresh_token grant MAS refused
//
// A refusal is sorted by WHY (mediaauth-core.js refusalReason), because "a
// signed-in reader saw a 403" was two different facts wearing one lamp:
//
//   RED    the session itself is dead -- its token sees no room, or Synapse
//          does not know it. That is the 2026-09-19 incident, and one is
//          enough: every picture that reader asks for will fail.
//   AMBER  the image is in no room the server can see -- deleted by its
//          poster, never posted, or in an encrypted room the client did not
//          name. Worth a look if it repeats; not an outage. Before this split
//          the lamp went red all night on 2026-09-28 for an image deleted in
//          June, and the gate was right every time.
//   GREEN  the image is in rooms and the reader is in none of them: the gate
//          doing its job. Counted, so a surge is visible, never flagged.
//
// A stale-unrenewable session is AMBER: it will be refused on its next Matrix
// picture, and it is fixable by that reader signing in again.
//
// The booru door (leak audit 2026-10-01) adds two:
//
//   booru_unavailable  the booru could not be asked whether a post is
//                      visible, so booru media was refused (fail closed). RED:
//                      every booru picture fails while it lasts.
//   publications_unavailable  sampling could not be asked whether a published
//                      page shows an md5 its reader holds the grant for. RED:
//                      published pages' restricted pictures fail meanwhile.
//   publication_grants an md5 released on a live publication's grant. Counted.
//   booru_hidden       an md5 asked for that no visible post carries -- a
//                      jailed, deleted or never-posted image. The gate working;
//                      counted so a scan of the jail shows up, never flagged.
//   matrix_refused     an md5 asked for at the booru door whose file is a
//                      Matrix image's and that no visible non-Matrix post
//                      holds. AMBER: the booru links Matrix posts through the
//                      Matrix door, so a refusal here is a guess or a mislink
//                      -- and until 2026-10-05 it was also thirteen 4chan posts
//                      404ing with no trace anywhere. Worth a look if it repeats.
//
// The quarantine (operator rulings 2026-10-12; booru-quarantine.js) adds two:
//
//   quarantine_refused     an image refused at the Matrix door or on a
//                          publication's grant because the booru's quarantine
//                          document names it (a flagged or banished tag, or
//                          troll_jail).
//                          AMBER: flagged media is being asked for while it
//                          awaits review. The detail is the path, never a tag.
//   quarantine_unavailable the quarantine document could not be read (or is
//                          past its bound), so the Matrix door answered 503 and
//                          grants were refused (fail closed). RED, with the fix.
//
// WHO SEES THE DETAIL (F-G5). The "last:" strings name mxc ids and Matrix user
// ids. health({ detail: false }) leaves them out -- levels, labels and counts
// only -- and that is what a public caller of /healthz gets.

const WINDOW_MS = 10 * 60 * 1000;
const CAP = 5000;

class GateSignals {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.rings = { session_refusals: [], unplaced_media: [], member_refusals: [], stale_unrenewable: [], refresh_failures: [], booru_unavailable: [], booru_hidden: [], matrix_refused: [], publications_unavailable: [], publication_grants: [], quarantine_refused: [], quarantine_unavailable: [] };
    this.last = {};
  }

  #note(kind, detail) {
    const ring = this.rings[kind];
    if (!ring) return;
    ring.push(this.now());
    if (ring.length > CAP) ring.splice(0, ring.length - CAP);
    if (detail) this.last[kind] = detail;
  }

  // reason: mediaauth-core's refusal reason. An unknown or absent reason is
  // RED -- a refusal nobody explained is exactly what the lamp is for.
  sessionRefused(status, detail, reason) {
    const text = `${status}${detail ? ` ${detail}` : ""}`;
    if (reason === "unplaced") this.#note("unplaced_media", text);
    else if (reason === "not-member") this.#note("member_refusals", text);
    else this.#note("session_refusals", reason ? `${text} (${reason})` : text);
  }
  staleUnrenewable(detail) { this.#note("stale_unrenewable", detail); }
  refreshFailed(detail) { this.#note("refresh_failures", detail); }
  booruUnavailable(detail) { this.#note("booru_unavailable", detail); }
  booruHidden(detail) { this.#note("booru_hidden", detail); }
  matrixRefused(detail) { this.#note("matrix_refused", detail); }
  publicationsUnavailable(detail) { this.#note("publications_unavailable", detail); }
  publicationGranted(detail) { this.#note("publication_grants", detail); }
  quarantineRefused(detail) { this.#note("quarantine_refused", detail); }
  quarantineUnavailable(detail) { this.#note("quarantine_unavailable", detail); }

  counts(at = this.now()) {
    const out = {};
    for (const [k, ring] of Object.entries(this.rings)) {
      const cut = at - WINDOW_MS;
      let i = 0;
      while (i < ring.length && ring[i] < cut) i++;
      if (i) ring.splice(0, i);
      out[k] = ring.length;
    }
    return out;
  }

  /** The health document's checks and overall level, for /healthz. */
  health(at = this.now(), { detail = true } = {}) {
    const c = this.counts(at);
    // The last thing seen, or nothing at all for a caller not allowed detail.
    const last = (k) => (detail ? `; last: ${this.last[k] || "?"}` : "");
    const checks = [
      {
        id: "session-refusals",
        label: "signed-in readers refused",
        level: c.session_refusals > 0 ? "red" : "green",
        detail: c.session_refusals > 0
          ? `${c.session_refusals} refusal(s) to a session whose token sees no room in 10 min${last("session_refusals")}`
          : "none in 10 min",
      },
      {
        id: "unplaced-media",
        label: "images asked for that are in no room",
        level: c.unplaced_media > 0 ? "amber" : "green",
        detail: c.unplaced_media > 0
          ? `${c.unplaced_media} in 10 min (deleted by its poster, or in an encrypted room the client did not name)${last("unplaced_media")}`
          : "none in 10 min",
      },
      {
        id: "member-refusals",
        label: "readers refused a room they are not in",
        level: "green",
        detail: `${c.member_refusals} in 10 min -- the gate answering correctly${c.member_refusals > 0 ? last("member_refusals") : ""}`,
      },
      {
        id: "refresh-failures",
        label: "token refresh refused by MAS",
        level: c.refresh_failures > 0 ? "red" : "green",
        detail: c.refresh_failures > 0 ? `${c.refresh_failures} in 10 min${last("refresh_failures")}` : "none in 10 min",
      },
      {
        id: "stale-unrenewable",
        label: "sessions past their token with no refresh",
        level: c.stale_unrenewable > 0 ? "amber" : "green",
        detail: c.stale_unrenewable > 0
          ? `${c.stale_unrenewable} in 10 min (a sign-out/in fixes it)${last("stale_unrenewable")}`
          : "none in 10 min",
      },
      {
        id: "booru-visibility",
        label: "booru asked which posts a reader may see",
        level: c.booru_unavailable > 0 ? "red" : "green",
        detail: c.booru_unavailable > 0
          ? `${c.booru_unavailable} ask(s) failed in 10 min -- booru media refused while the booru cannot answer${last("booru_unavailable")}`
          : "answering",
      },
      {
        id: "booru-hidden",
        label: "booru media refused: no visible post",
        level: "green",
        detail: `${c.booru_hidden} in 10 min -- jailed, deleted or never posted${c.booru_hidden > 0 ? last("booru_hidden") : ""}`,
      },
      {
        id: "booru-matrix-refused",
        label: "booru media refused: a Matrix image with no non-Matrix post",
        level: c.matrix_refused > 0 ? "amber" : "green",
        detail: c.matrix_refused > 0
          ? `${c.matrix_refused} in 10 min -- served only through the Matrix door; a booru post linking it here is a mislink${last("matrix_refused")}`
          : "none in 10 min",
      },
      {
        id: "publication-grants",
        label: "published pages' pictures, checked with sampling",
        level: c.publications_unavailable > 0 ? "red" : "green",
        detail: c.publications_unavailable > 0
          ? `${c.publications_unavailable} check(s) failed in 10 min -- a published page's restricted pictures refused while sampling cannot answer${last("publications_unavailable")}`
          : `${c.publication_grants} granted in 10 min`,
      },
      {
        id: "quarantine-refused",
        label: "pictures refused: in the booru's quarantine (flagged or banished tag, or jailed)",
        level: c.quarantine_refused > 0 ? "amber" : "green",
        detail: c.quarantine_refused > 0
          ? `${c.quarantine_refused} in 10 min at the Matrix door or a publication's grant -- flagged media awaiting review in the booru's queue${last("quarantine_refused")}`
          : "none in 10 min",
      },
      {
        id: "quarantine-unavailable",
        label: "booru quarantine document readable",
        level: c.quarantine_unavailable > 0 ? "red" : "green",
        detail: c.quarantine_unavailable > 0
          ? `${c.quarantine_unavailable} picture(s) refused in 10 min because the quarantine could not be read -- check BOORU_QUARANTINE_LOGIN / BOORU_QUARANTINE_API_KEY, that the account is in Danbooru.config.fourier_quarantine_reader_names, and that chanbooru is deployed with the quarantine build${last("quarantine_unavailable")}`
          : "no refusals for an unreadable quarantine in 10 min",
      },
    ];
    const level = checks.some((x) => x.level === "red") ? "red" : checks.some((x) => x.level === "amber") ? "amber" : "ok";
    return { level, checks, counts: c };
  }
}

module.exports = { GateSignals, WINDOW_MS };
