const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createSession, getSession, destroySession, redisPing,
        putOidcState, takeOidcState, cacheGetJson, cacheSetJson } = require("./session");
const { getProvider } = require("./providers");
const { checkMediaAccess } = require("./mediaauth");
const { makeVerifyHandler } = require("./verify");
const { originalRelease } = require("./release");
const { resolveR2Key } = require("./mediar2");
const { parseBooruFile, pickVariant, booruR2Key } = require("./booru-media");

const app = express();
app.use(cookieParser());
app.use(express.json());

const SYNAPSE_URL = process.env.SYNAPSE_URL || "http://synapse:8008";
const PORT = process.env.PORT || 8010;
const COOKIE_NAME = "fourier_session";
const POST_LOGIN_REDIRECT = process.env.POST_LOGIN_REDIRECT || "https://booru.41chan.net/";

// Local homeserver name as it appears in mxc URIs (the delegation host).
// Only originals for THIS server are redirected to R2; remote-server media
// falls through to the Synapse proxy (different key layout, small volume).
const HOMESERVER_NAME = process.env.HOMESERVER_NAME || "41chan.net";

// R2 (S3-compatible) config for presigned-URL redirects of local originals.
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PRESIGN_TTL = parseInt(process.env.R2_PRESIGN_TTL || "300", 10);
const r2Enabled = !!(R2_ENDPOINT && R2_BUCKET &&
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

// R2 client. region "auto" is what Cloudflare R2 expects; credentials come
// from the standard AWS_* names, which we map from our R2_* env explicitly.
const s3 = r2Enabled ? new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;

if (!r2Enabled) {
  console.warn("[media] R2 not configured -- originals will proxy through Synapse");
}

// Key derivation for every media class lives in mediar2.js -- one copy, so
// local and remote shapes cannot drift apart.

// Mint a short-lived presigned GET URL for a local original in R2.
async function presignKey(key) {
  const cmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    // Force R2 to return a long-lived cache header on the image response.
    // The stored objects carry no Cache-Control, so without this the browser
    // re-downloads the full original on every view. mxc content is immutable
    // (Synapse mints a fresh mxc per upload), so a year + immutable is safe.
    ResponseCacheControl: "private, max-age=31536000, immutable",
  });
  return getSignedUrl(s3, cmd, { expiresIn: R2_PRESIGN_TTL });
}

// Thumbnail sizes the gate will request from Synapse. Requested ?w=/?h=
// values are snapped to the nearest entry so callers can't induce
// arbitrary-size thumbnail generation.
const ALLOWED_THUMB_SIZES = [180, 320, 360, 720, 850];

// Origins allowed to call the media proxy cross-origin with a Bearer token
// (first-party SPA clients like Technetium). Comma-separated env; empty = none.
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Reflect CORS headers only for allow-listed origins. Bearer mode is header-
// based (no cross-origin cookies), so we deliberately do NOT allow credentials.
function applyMediaCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CLIENT_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization");
  }
}

// Health check (also verifies Redis connectivity)
app.get("/healthz", async (req, res) => {
  let redisOk = false;
  try { redisOk = (await redisPing()) === "PONG"; } catch (e) {}
  res.json({ status: "ok", service: "fourier-auth", redis: redisOk });
});

// Login: begin the OIDC Authorization Code flow. Redirects the browser to
// MAS. State + PKCE verifier are stashed in Redis (single-use, short TTL).
app.get("/login", async (req, res) => {
  const provider = getProvider("oidc");
  try {
    const { url, state, codeVerifier } = await provider.authUrl();
    await putOidcState(state, { codeVerifier });
    res.redirect(url);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// OIDC redirect target: MAS sends the user back here with code + state.
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).json({ error: "missing code or state" });
  }
  const stored = await takeOidcState(state);
  if (!stored) {
    return res.status(400).json({ error: "unknown or expired state" });
  }
  try {
    const provider = getProvider("oidc");
    const identity = await provider.exchange({
      code,
      codeVerifier: stored.codeVerifier,
    });
    const sid = await createSession({
      matrixUserId: identity.matrixUserId,
      matrixToken: identity.matrixToken,
    });
    res.cookie(COOKIE_NAME, sid, { httpOnly: true, sameSite: "lax" });
    res.redirect(POST_LOGIN_REDIRECT);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Logout
app.post("/logout", async (req, res) => {
  await destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// CORS preflight for the media proxy: a Bearer Authorization header makes the
// cross-origin GET a non-simple request, so the browser sends OPTIONS first.
app.options("/media/:serverName/:mediaId", (req, res) => {
  applyMediaCors(req, res);
  res.set("Access-Control-Max-Age", "600");
  res.sendStatus(204);
});

// Media proxy: resolves the caller's session -> Matrix token, authorizes, then
// nginx auth_request identity resolver: fourier_session cookie -> verified MXID
// in the X-Fourier-Identity header. Always 2xx so auth_request never blocks a
// public page (see verify.js). Reuses the existing getSession + COOKIE_NAME.
app.get("/verify", makeVerifyHandler({ getSession, cookieName: COOKIE_NAME }));

// --- booru-native media ----------------------------------------------------
//
// Objects fourier-sampling put in R2, served for a booru that holds no media
// of its own (operator ruling 2026-08-11: R2 receives, holds and serves it).
//
// Deliberately NOT the /media/:serverName/:mediaId route. That one authorises
// by Matrix room membership, which is the right question for an mxc and a
// meaningless one here -- these objects live in no room. Reusing it would have
// meant either weakening its authorisation or inventing a room for a 4chan
// image. Separate route, separate rule, one job each.
//
// Access: a valid fourier_session is required (operator ruling). This is
// STRICTER than the booru is today -- /data/original/<md5> currently answers
// 200 to anyone -- so it is a tightening, not a regression. It does mean a
// logged-out visitor sees no images, which is why it is a flag: flip
// BOORU_MEDIA_REQUIRE_SESSION=0 to restore public bytes without a redeploy.
//
// Bearer tokens are NOT accepted here, unlike the mxc route. There, Synapse is
// the downstream authority that validates the token; here there is no such
// downstream, so honouring a Bearer would mean trusting an unvalidated string.
// Technetium does not display booru media today; when it needs to, this wants a
// whoami check against Synapse rather than a shortcut.
const BOORU_MEDIA_REQUIRE_SESSION = (process.env.BOORU_MEDIA_REQUIRE_SESSION ?? "1") !== "0";

// How an authorized local ORIGINAL reaches a native browser load.
//   "redirect" 302 to a presigned R2 URL; no media byte touches this host (default)
//   "proxy"    stream it through here; clean URL, but THIS HOST SERVES THE BYTES
//
// The default is not a performance choice. Operator ruling, restated
// 2026-08-15: "41chan is not supposed to hold media or serve media outside of
// site assets." The host does not permit adult content, and that applies to
// bytes in transit through it, not only to bytes at rest on it. `proxy` exists
// to be switchable for a deployment where that constraint does not apply; on
// 41chan it must stay off.
// Only affects native loads. cors fetch() callers keep the JSON envelope in
// both modes -- see release.js for why that is not negotiable.
const ORIGINAL_RELEASE_MODE =
  (process.env.MEDIA_ORIGINAL_RELEASE || "redirect").toLowerCase() === "proxy" ? "proxy" : "redirect";

app.get("/booru/:file", async (req, res) => {
  // Parsed rather than interpolated: this string becomes an object key, and
  // the gate is reachable by more than the booru. See booru-media.test.js.
  const parsed = parseBooruFile(req.params.file);
  if (!parsed) return res.status(400).json({ error: "bad media path" });

  applyMediaCors(req, res);

  if (!r2Enabled) {
    // No Synapse fallback exists for these -- R2 is the only copy, by design.
    return res.status(503).json({ error: "R2 not configured" });
  }

  // The SAME fourier login that already gates Synapse media (operator, 2026-08-11).
  // Not a second sign-in: a user who has logged in to see mxc media is already
  // carrying this cookie, so booru media comes with it and no new flow appears.
  if (BOORU_MEDIA_REQUIRE_SESSION) {
    const session = await getSession(req.cookies[COOKIE_NAME]);
    if (!session) return res.status(401).json({ error: "no valid session" });
  }

  // ?w=/?h= mirrors the mxc route, so chanbooru builds both URL shapes alike.
  const variant = pickVariant(req.query);

  try {
    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: booruR2Key(parsed.md5, parsed.ext, variant),
      // md5-keyed content is immutable by construction, so a year is safe and
      // saves re-fetching a full original on every view.
      ResponseCacheControl: "private, max-age=31536000, immutable",
    });
    const signed = await getSignedUrl(s3, cmd, { expiresIn: R2_PRESIGN_TTL });
    // The presigned URL is short-lived, so neither the 302 nor the JSON
    // envelope may be cached and replayed stale.
    res.set("Cache-Control", "no-store");
    if (originalRelease(req.headers) === "redirect") {
      return res.redirect(302, signed);
    }
    return res.json({ url: signed });
  } catch (err) {
    console.error("[booru-media] presign failed:", err.message);
    return res.status(502).json({ error: "could not release media" });
  }
});

// releases local originals from R2 (content-negotiated: a 302 to a presigned URL
// for native browser loads, or a JSON { url } envelope for fetch()/XHR callers --
// see release.js) OR streams from Synapse (thumbnails, and remote-server
// originals). Either way the bytes go client <- R2/Synapse, origin out of the path.
// Thumbnails: ?w=<px>&h=<px> (snapped to ALLOWED_THUMB_SIZES), or legacy ?thumb=1 (320).
app.get("/media/:serverName/:mediaId", async (req, res) => {
  const { serverName, mediaId } = req.params;

  let thumbSize = null;
  if (req.query.w || req.query.h) {
    const want = parseInt(req.query.w || req.query.h, 10) || 320;
    thumbSize = ALLOWED_THUMB_SIZES.reduce((a, b) =>
      Math.abs(b - want) < Math.abs(a - want) ? b : a);
  } else if (req.query.thumb === "1") {
    thumbSize = 320;
  }

  applyMediaCors(req, res);

  // Token broker, two ways in (Bearer header wins when present):
  //   Authorization: Bearer <MAS token> -> first-party clients (Technetium)
  //     that already hold the user's MAS token; header-based, so no cookie /
  //     SameSite friction cross-origin.
  //   fourier_session cookie             -> the booru's same-site path.
  // Synapse remains the final authority on validity: an invalid token earns a
  // 401 from the upstream media endpoint, which we pass straight through.
  let token = null;
  const authz = req.headers.authorization || "";
  if (authz.startsWith("Bearer ")) {
    token = authz.slice(7).trim();
  } else {
    const session = await getSession(req.cookies[COOKIE_NAME]);
    if (session) token = session.matrixToken;
  }
  if (!token) {
    return res.status(401).json({ error: "no valid session or bearer token" });
  }

  // Per-room authorization: Synapse authenticates the token but does NOT enforce
  // that the user can see the room this mxc lives in (MSC3916 scoping). Enforce
  // it here -- allow only if the token's owner is joined to a room containing
  // this media. Fail closed. Applies to BOTH bearer (client) and cookie (booru).
  const allowed = await checkMediaAccess(token, serverName, mediaId);
  if (!allowed) {
    return res.status(403).json({ error: "not authorized for this media" });
  }

  // R2 release, for EVERY class of media this gate can serve -- local and
  // remote, original and thumbnail. Two ways to hand it over, and only ONE of
  // them puts a credential in the address bar.
  //
  // The 302 hands the browser a presigned R2 URL: ~400 characters of
  // X-Amz-Credential, X-Amz-Date, X-Amz-SignedHeaders and X-Amz-Signature,
  // every one of them load-bearing, because for SigV4 the signature IS the
  // authorization. That URL then lives in the DOM, in history, in devtools and
  // in anything a page extension can read -- a bearer credential in a URL,
  // which is precisely what this project's own rules say never to create. It
  // was the right trade when the alternative was proxying every byte; it is
  // not a small cost.
  //
  // Proxying instead would reuse the streaming path below and give a clean URL
  // -- and it is WRONG HERE, which is worth writing down because the code alone
  // makes it look like a free improvement.
  //
  // Operator ruling, restated 2026-08-15: "41chan is not supposed to hold media
  // or serve media outside of site assets." The host does not permit adult
  // content. That constraint covers bytes TRANSITING this machine, not only
  // bytes at rest on it -- the same reason the sampling spool is a tmpfs. A
  // proxy here would have put ~1.7 GB/day of user media through this host
  // (888 original requests in 24h at ~2 MB each, measured from the booru's own
  // nginx), which is exactly what the ruling forbids.
  //
  // So the long URL stays, and the right fix for it is somewhere else: a
  // Cloudflare Worker fronting R2, where the bytes never enter 41chan at all.
  // See MEDIA-URLS.md.
  //
  // The JSON envelope is NOT affected either way: a cors fetch() must keep
  // receiving { url }, because a fetch that follows a cross-origin 302 gets its
  // Origin tainted to "null" and R2's CORS allow-list cannot match it. See
  // release.js -- that invariant is why this is a redirect-only change.
  //
  // Widened 2026-08-15 from local-originals-only. Thumbnails and remote
  // originals were streaming through this host -- 3,724 thumbnail requests in
  // 24h -- which the ruling forbids exactly as much as bytes at rest. A
  // thumbnail key is not derivable from the request (the stored name carries
  // the RENDERED size, not the requested one), so mediar2.js resolves it by
  // listing that object's own thumbnail prefix, cached hard because a
  // rendition is immutable once written.
  //
  // resolveR2Key returning null means R2 genuinely does not hold it, and the
  // streaming fallback below is then correct rather than a failure.
  if (r2Enabled
      && !(ORIGINAL_RELEASE_MODE === "proxy" && originalRelease(req.headers) === "redirect")) {
    try {
      const key = await resolveR2Key(s3, R2_BUCKET, {
        serverName,
        mediaId,
        isLocal: serverName === HOMESERVER_NAME,
        thumbSize,
        method: "scale",
        cache: { get: cacheGetJson, set: cacheSetJson },
      });
      if (!key) throw new Error("not in R2");
      const signed = await presignKey(key);
      // No-store on both paths: the presigned URL is short-lived, so neither the
      // JSON envelope nor the 302 mapping may be cached and reused stale.
      res.set("Cache-Control", "no-store");
      // Content-negotiate the release (see release.js for the full rationale and
      // the never-redirect-a-cors-fetch safety invariant). Native browser loads
      // (<img>, link navigation, download) get a 302 straight to R2 and work with
      // no client-side resolution; fetch()/XHR callers (Technetium) keep JSON.
      if (originalRelease(req.headers) === "redirect") {
        return res.redirect(302, signed);
      }
      return res.json({ url: signed });
    } catch (err) {
      // Presign failure -> fall through to the Synapse proxy below rather than
      // failing the request. Authorization already succeeded; this is a
      // delivery-path fallback, not an authz bypass.
      // Not an error path in the usual sense: R2 not holding an object is a
      // real and expected state (74 zero-byte failed federation fetches, plus
      // anything mid-upload). Falling through streams it, which is worse for
      // the ruling but better than a broken image.
      console.error(`[media] R2 release unavailable for ${serverName}/${mediaId}, proxying:`, err.message);
    }
  }

  const base = `${SYNAPSE_URL}/_matrix/client/v1/media`;
  const url = thumbSize
    ? `${base}/thumbnail/${serverName}/${mediaId}?width=${thumbSize}&height=${thumbSize}&method=scale`
    : `${base}/download/${serverName}/${mediaId}`;

  try {
    const upstream = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
      validateStatus: () => true,
    });
    if (upstream.status !== 200) {
      return res.status(upstream.status).json({
        error: "synapse refused media request",
        status: upstream.status,
      });
    }
    if (upstream.headers["content-type"]) {
      res.set("Content-Type", upstream.headers["content-type"]);
    }
    // Forward Synapse's Cache-Control so the browser can cache media locally
    // (kills the re-fetch-on-every-load egress). Synapse's header keeps
    // s-maxage=0, which stops Cloudflare from EDGE-caching authenticated media
    // -- important, since a shared-cache HIT would bypass our per-room authz.
    // Fall back to a browser-only default if upstream omits it.
    // A local original is content-addressed -- the bytes under an mxc id never
    // change -- so it earns the same year-long private cache the presigned URL
    // carries via ResponseCacheControl. This applies to the paths that DO still
    // stream through this host (thumbnails, remote originals, and the
    // presign-failure fallback): the longer a browser holds them, the fewer
    // media bytes cross this machine, which is the constraint that matters here
    // rather than the bandwidth.
    //
    // `private` rather than Synapse's `public + s-maxage=0`: both keep the
    // bytes out of Cloudflare's edge, which MUST hold or a shared-cache hit
    // would bypass the per-room authorization above -- but `private` states it
    // outright instead of relying on every proxy in the path honouring
    // s-maxage=0.
    const immutableOriginal = !thumbSize && serverName === HOMESERVER_NAME;
    res.set("Cache-Control",
      immutableOriginal
        ? "private, max-age=31536000, immutable"
        : upstream.headers["cache-control"] || "private, max-age=86400, s-maxage=0");
    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: "upstream error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`fourier-auth listening on port ${PORT}`);
});
