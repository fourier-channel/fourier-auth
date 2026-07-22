const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createSession, getSession, destroySession, redisPing,
        putOidcState, takeOidcState } = require("./session");
const { getProvider } = require("./providers");
const { checkMediaAccess } = require("./mediaauth");
const { originalRelease } = require("./release");

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

// Synapse's s3-storage-provider mirrors the local media store layout into the
// bucket: local originals live at local_content/<AA>/<BB>/<rest>, where AA/BB
// are the first two 2-char shards of the media ID. Pure string derivation --
// no DB, no new coupling.
function localOriginalR2Key(mediaId) {
  return `local_content/${mediaId.slice(0, 2)}/${mediaId.slice(2, 4)}/${mediaId.slice(4)}`;
}

// Mint a short-lived presigned GET URL for a local original in R2.
async function presignOriginal(mediaId) {
  const cmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: localOriginalR2Key(mediaId),
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

  // Local original + R2 configured -> redirect to a presigned R2 URL. Bytes go
  // client <- R2 directly; the origin never touches them. Authorization has
  // already passed above; the short-TTL presigned URL is the release token.
  if (!thumbSize && r2Enabled && serverName === HOMESERVER_NAME) {
    try {
      const signed = await presignOriginal(mediaId);
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
      console.error("[media] presign failed, falling back to proxy:", err.message);
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
    res.set("Cache-Control",
      upstream.headers["cache-control"] ||
      "private, max-age=86400, s-maxage=0");
    upstream.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: "upstream error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`fourier-auth listening on port ${PORT}`);
});
