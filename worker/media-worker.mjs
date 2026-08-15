/**
 * Cloudflare Worker: serve Matrix media without 41chan ever touching the bytes.
 *
 * THE PROBLEM IT SOLVES. Element fetches media from
 * matrix.41chan.net/_matrix/client/v1/media/* with the user's access token.
 * Synapse answers by streaming the bytes -- from local disk, or from R2 if the
 * local copy is gone. Either way they cross 41chan, and the operator ruling is
 * that they must not: "41chan is not supposed to hold media or serve media
 * outside of site assets."
 *
 * Nothing running ON 41chan can fix that, because anything running on 41chan is
 * in the path by definition. Synapse cannot be made to redirect either -- the
 * installed s3_storage_provider exposes only fetch(), with no redirect hook.
 * The only place left to stand is Cloudflare, which already fronts this
 * hostname.
 *
 * SHAPE. Authorization is delegated, bytes are not:
 *
 *   Element ---(Bearer token)---> Worker
 *   Worker  ---(same token)-----> fourier-auth  "may this token see this, and where is it?"
 *                                 (a few hundred bytes, over 41chan)
 *   Worker  ---(presigned URL)--> R2            (the image, never over 41chan)
 *   Worker  ---(bytes)----------> Element
 *
 * fourier-auth already answers exactly that question, for exactly this token
 * shape, with the per-room membership check MSC3916 leaves out. Re-implementing
 * that check here would be a second copy of the rule that decides who may see
 * what -- the single most dangerous thing in the system to have two of.
 *
 * CACHING. The bytes are cached at the edge keyed on the R2 object, and the
 * AUTHORIZATION IS NOT. Every request re-asks fourier-auth. A cached
 * authorization is a user who left a room still reading it; a cached object is
 * just bytes that are immutable anyway.
 */

/** Parse a Matrix authenticated-media path. Null for anything else. */
export function parseMediaPath(pathname) {
  const m = /^\/_matrix\/client\/v1\/media\/(download|thumbnail)\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  return { kind: m[1], serverName: decodeURIComponent(m[2]), mediaId: decodeURIComponent(m[3]) };
}

/**
 * The fourier-auth URL that answers "may this token see this, and where is it?"
 *
 * Thumbnail sizing is passed through as ?w=/?h=, which that gate snaps to its
 * own allowed set -- so the Worker never invents a size and the two cannot
 * disagree about which rendition is correct.
 */
export function authUrl(base, { serverName, mediaId, kind }, searchParams) {
  const u = new URL(`${base.replace(/\/+$/, "")}/media/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`);
  if (kind === "thumbnail") {
    const w = searchParams.get("width") || searchParams.get("w");
    const h = searchParams.get("height") || searchParams.get("h");
    if (w) u.searchParams.set("w", w);
    if (h) u.searchParams.set("h", h);
  }
  return u.toString();
}

/**
 * Ask fourier-auth. Returns { ok, url } or { ok:false, status }.
 *
 * Sec-Fetch-Mode: cors is sent deliberately: it makes fourier-auth answer with
 * the { url } JSON envelope rather than a 302. A Worker following a redirect
 * would work, but the envelope means the presigned URL never becomes a
 * client-visible Location header even by accident.
 */
export async function resolveUpstream(fetchImpl, url, authorization) {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
  });
  if (res.status !== 200) return { ok: false, status: res.status };
  const body = await res.json().catch(() => null);
  if (!body || typeof body.url !== "string") return { ok: false, status: 502 };
  return { ok: true, url: body.url };
}

/** Headers to hand the client. The presigned URL is never among them. */
export function responseHeaders(upstreamHeaders, _kind) {
  const h = new Headers();
  const ct = upstreamHeaders.get("content-type");
  if (ct) h.set("Content-Type", ct);
  const len = upstreamHeaders.get("content-length");
  if (len) h.set("Content-Length", len);
  // Content-addressed and immutable, and private because it is authorized per
  // user -- the same header the origin sets for the same reason.
  h.set("Cache-Control", "private, max-age=31536000, immutable");
  // Decided by CONTENT TYPE, not by which endpoint was called -- which is what
  // the spec (MSC2702) says and what Synapse does. Serving every download as
  // an attachment would have been a behaviour change on the one path that
  // carries all of Element's media, for no reason: a thumbnail and an original
  // of the same PNG are equally safe to render.
  //
  // The allowlist is the point. Anything not on it is forced to download rather
  // than being rendered as an active document, so an uploaded .html cannot
  // execute in the origin of whoever opens it.
  const type = (ct || "").split(";")[0].trim().toLowerCase();
  const inlineSafe = /^(image\/(jpeg|png|gif|webp|apng|avif)|video\/(mp4|webm|ogg)|audio\/(mp4|webm|ogg|mpeg|flac|wave?))$/.test(type);
  h.set("Content-Disposition", inlineSafe ? "inline" : "attachment");
  h.set("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  return h;
}

/**
 * CORS, copied from what Synapse answers on the same paths.
 *
 * Not optional and not cosmetic. Every Matrix client that is not served from
 * the homeserver's own origin -- Technetium on localhost, any third-party
 * client -- reads media with a cross-origin fetch carrying an Authorization
 * header, which browsers preflight. Intercepting these paths without answering
 * CORS breaks those clients completely while leaving Element (same-origin,
 * no preflight) working perfectly, so the breakage is invisible from the one
 * client most likely to be tested.
 *
 * `*` rather than echoing the Origin is what Synapse does and is safe here:
 * these responses are authorized by the Authorization header, never by a
 * cookie, so no browser will attach ambient credentials to them.
 */
export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "X-Requested-With, Content-Type, Authorization, Date",
    "Access-Control-Expose-Headers": "Content-Length, Content-Type, Content-Disposition",
  };
}

/** A Matrix-shaped error, so clients read it the way they read Synapse's. */
export function deny(status, errcode, error) {
  return new Response(JSON.stringify({ errcode, error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parsed = parseMediaPath(url.pathname);

    // Not a media path -> not ours. Hand it to the origin untouched.
    if (!parsed) return fetch(request);

    // Preflight. A cross-origin client sending Authorization gets one of these
    // FIRST, and it carries no token -- so it must be answered before any
    // authorization check, or every non-same-origin client fails with an
    // opaque "CORS request did not succeed" and never sends the real request.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" } });
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization) return deny(401, "M_MISSING_TOKEN", "Missing access token");

    const decision = await resolveUpstream(
      fetch,
      authUrl(env.FOURIER_AUTH_BASE, parsed, url.searchParams),
      authorization,
    );
    // Kept, not temporary. A Worker that authorizes NOTHING looked exactly like
    // one that was working, because the origin served everything it refused --
    // which is how this shipped "verified" and was not. No token material is
    // logged, only the decision.
    console.log(JSON.stringify({ path: url.pathname, kind: parsed.kind, ok: decision.ok, authStatus: decision.status ?? 200 }));

    if (!decision.ok) {
      // FAIL CLOSED. Operator ruling 2026-08-15: "Synapse should not be serving
      // anything besides site assets, and especially should not be serving
      // anything that fourier-auth denies. That is the point of fourier-auth."
      //
      // The previous version fell through to the origin here, reasoning that a
      // broken image was worse than a byte crossing the host. That was wrong
      // twice over. It defeated the authorization it had just delegated --
      // fourier-auth said no and Synapse said yes, because Synapse authenticates
      // the token without the per-room check MSC3916 leaves out -- and it made
      // the Worker a silent no-op for every request it refused.
      //
      // Infrastructure failure fails closed too. fourier-auth being unreachable
      // is an outage, and an outage that hides itself by leaking bytes is the
      // exact failure mode this whole system has been unpicking all week.
      const status = decision.status === 401 || decision.status === 403 ? decision.status : 502;
      return deny(status,
        status === 401 ? "M_UNAUTHORIZED" : status === 403 ? "M_FORBIDDEN" : "M_UNKNOWN",
        status === 502 ? "Media authorization is unavailable" : "Not authorized for this media");
    }

    // Edge cache keyed on the R2 object, NOT on the client's request -- so two
    // authorized users share one cached copy and an unauthorized one never
    // reaches this line.
    const cacheKey = new Request(decision.url.split("?")[0], { method: "GET" });
    const cache = caches.default;
    let upstream = await cache.match(cacheKey);
    if (!upstream) {
      upstream = await fetch(decision.url);
      if (upstream.ok) {
        const cacheable = new Response(upstream.clone().body, upstream);
        cacheable.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        ctx.waitUntil(cache.put(cacheKey, cacheable));
      }
    }
    // Authorized, but the object could not be read. Still no origin fallback:
    // the answer is a visible error, not a byte that should not exist.
    if (!upstream.ok) return deny(502, "M_UNKNOWN", "Media store unavailable");

    return new Response(upstream.body, {
      status: 200,
      headers: responseHeaders(upstream.headers, parsed.kind),
    });
  },
};
