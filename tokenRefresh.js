"use strict";

// KEEPS A COOKIE SESSION'S MATRIX TOKEN ALIVE FOR THE LIFE OF THE SESSION.
//
// A fourier_session lives 24 hours in Redis and holds a MAS access token that
// lives five minutes. Nothing refreshed it: the OIDC callback kept only the
// access token, so from minute six every Matrix-origin picture the booru
// showed was refused by the gate -- 401 where Synapse said so, 403 where the
// joined-rooms read came back empty because the token was dead -- while the
// session bar, reading the Redis TTL, said 23 hours remained (operator,
// 2026-09-19: "a green lamp that's not measuring the thing it's supposed to
// be measuring"). Logging out and in minted a new token and bought five more
// minutes.
//
// So the session now carries the refresh token and the token's expiry, and
// this is the one place a token is handed out for use: if it is within a
// minute of expiring, it is refreshed first. Concurrent callers for the same
// session share one refresh, because MAS ROTATES refresh tokens -- the second
// of two racing refreshes would present a token already spent and be refused,
// and the session would be dead for good. The session is re-read inside the
// lock for the same reason.
//
// A session without a refresh token (minted by /exchange from a client's own
// bearer, which is the client's to refresh) is handed out as it is, and the
// case is logged when it is stale so the lamp has something to read.

const REFRESH_AHEAD_MS = 60_000;

function makeTokenSource({ getSession, saveSession, refreshGrant, now = () => Date.now(), log = console }) {
  const inflight = new Map();

  function isStale(session, at) {
    return typeof session.tokenExpiresAt === "number" && session.tokenExpiresAt - at < REFRESH_AHEAD_MS;
  }

  /** The session's Matrix token, refreshed first if it is about to expire. */
  async function freshToken(sid, session) {
    if (!session) return null;
    if (!isStale(session, now())) return session.matrixToken;
    if (!session.refreshToken) {
      log.warn(`[session] token past its life and no refresh token to renew it (${session.matrixUserId || "?"})`);
      return session.matrixToken;
    }
    if (inflight.has(sid)) return inflight.get(sid);
    const p = (async () => {
      try {
        // Re-read under the lock: a refresh that finished a moment ago has
        // already rotated the refresh token, and the copy we were handed is spent.
        const cur = (await getSession(sid)) || session;
        if (!isStale(cur, now())) return cur.matrixToken;
        const t = await refreshGrant(cur.refreshToken);
        const next = {
          ...cur,
          matrixToken: t.access_token,
          refreshToken: t.refresh_token || cur.refreshToken,
          tokenExpiresAt: now() + Math.max(30, Number(t.expires_in) || 300) * 1000,
        };
        await saveSession(sid, next);
        return next.matrixToken;
      } catch (err) {
        // The old token is handed back: Synapse will say what it thinks of it,
        // and the refusal is the truthful answer. Loud, because a refresh that
        // fails every time is the whole incident again.
        log.error(`[session] refresh failed for ${session.matrixUserId || "?"}: ${err.message}`);
        return session.matrixToken;
      } finally {
        inflight.delete(sid);
      }
    })();
    inflight.set(sid, p);
    return p;
  }

  return { freshToken, isStale, REFRESH_AHEAD_MS };
}

module.exports = { makeTokenSource, REFRESH_AHEAD_MS };
