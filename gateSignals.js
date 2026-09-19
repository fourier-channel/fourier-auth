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
// Any refusal is RED: one reader refused is the incident, not a trend. A
// stale-unrenewable session is AMBER: it will be refused on its next Matrix
// picture, and it is fixable by that reader signing in again.

const WINDOW_MS = 10 * 60 * 1000;
const CAP = 5000;

class GateSignals {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.rings = { session_refusals: [], stale_unrenewable: [], refresh_failures: [] };
    this.last = {};
  }

  #note(kind, detail) {
    const ring = this.rings[kind];
    if (!ring) return;
    ring.push(this.now());
    if (ring.length > CAP) ring.splice(0, ring.length - CAP);
    if (detail) this.last[kind] = detail;
  }

  sessionRefused(status, detail) { this.#note("session_refusals", `${status}${detail ? ` ${detail}` : ""}`); }
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
          ? `${c.session_refusals} refusal(s) to a session cookie in 10 min; last: ${this.last.session_refusals || "?"}`
          : "none in 10 min",
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
