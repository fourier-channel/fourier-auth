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

const WINDOW_MS = 10 * 60 * 1000;
const CAP = 5000;

class GateSignals {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.rings = { session_refusals: [], unplaced_media: [], member_refusals: [], stale_unrenewable: [], refresh_failures: [] };
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
  health(at = this.now()) {
    const c = this.counts(at);
    const checks = [
      {
        id: "session-refusals",
        label: "signed-in readers refused",
        level: c.session_refusals > 0 ? "red" : "green",
        detail: c.session_refusals > 0
          ? `${c.session_refusals} refusal(s) to a session whose token sees no room in 10 min; last: ${this.last.session_refusals || "?"}`
          : "none in 10 min",
      },
      {
        id: "unplaced-media",
        label: "images asked for that are in no room",
        level: c.unplaced_media > 0 ? "amber" : "green",
        detail: c.unplaced_media > 0
          ? `${c.unplaced_media} in 10 min (deleted by its poster, or in an encrypted room the client did not name); last: ${this.last.unplaced_media || "?"}`
          : "none in 10 min",
      },
      {
        id: "member-refusals",
        label: "readers refused a room they are not in",
        level: "green",
        detail: `${c.member_refusals} in 10 min -- the gate answering correctly${c.member_refusals > 0 ? `; last: ${this.last.member_refusals || "?"}` : ""}`,
      },
      {
        id: "refresh-failures",
        label: "token refresh refused by MAS",
        level: c.refresh_failures > 0 ? "red" : "green",
        detail: c.refresh_failures > 0 ? `${c.refresh_failures} in 10 min; last: ${this.last.refresh_failures || "?"}` : "none in 10 min",
      },
      {
        id: "stale-unrenewable",
        label: "sessions past their token with no refresh",
        level: c.stale_unrenewable > 0 ? "amber" : "green",
        detail: c.stale_unrenewable > 0
          ? `${c.stale_unrenewable} in 10 min (a sign-out/in fixes it); last: ${this.last.stale_unrenewable || "?"}`
          : "none in 10 min",
      },
    ];
    const level = checks.some((x) => x.level === "red") ? "red" : checks.some((x) => x.level === "amber") ? "amber" : "ok";
    return { level, checks, counts: c };
  }
}

module.exports = { GateSignals, WINDOW_MS };
