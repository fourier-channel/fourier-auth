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
export function responseHeaders(upstreamHeaders, kind) {
  const h = new Headers();
  const ct = upstreamHeaders.get("content-type");
  if (ct) h.set("Content-Type", ct);
  const len = upstreamHeaders.get("content-length");
  if (len) h.set("Content-Length", len);
  // Content-addressed and immutable, and private because it is authorized per
  // user -- the same header the origin sets for the same reason.
  h.set("Cache-Control", "private, max-age=31536000, immutable");
  // Matrix clients render media inline; the spec requires this on media
  // responses so a malicious upload cannot be served as an active document.
  h.set("Content-Disposition", kind === "thumbnail" ? "inline" : "attachment");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parsed = parseMediaPath(url.pathname);

    // Not a media path -> not ours. Hand it to the origin untouched.
    if (!parsed) return fetch(request);

    const authorization = request.headers.get("Authorization");
    if (!authorization) {
      // Pass through rather than 401: the origin owns the error contract, and
      // guessing it here would give clients a second, subtly different one.
      return fetch(request);
    }

    const decision = await resolveUpstream(
      fetch,
      authUrl(env.FOURIER_AUTH_BASE, parsed, url.searchParams),
      authorization,
    );
    if (!decision.ok) {
      // Authorization failed or the gate is unwell. Fall back to the origin so
      // media keeps working; it costs the ruling for that request, and a broken
      // image for every user is worse than a byte crossing the host.
      return fetch(request);
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
    if (!upstream.ok) return fetch(request);

    return new Response(upstream.body, {
      status: 200,
      headers: responseHeaders(upstream.headers, parsed.kind),
    });
  },
};
