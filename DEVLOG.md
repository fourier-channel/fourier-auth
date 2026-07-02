# Fourier — Auth (Matrix-Gated Media Proxy) Dev Log

**Project:** Fourier · **Component:** Auth (platform-gated media auth & token broker)
**Location:** /opt/fourier/auth/
**Status:** Live. Danbooru integration wired (media gate proven end to end), and
authentication migrated from Matrix password-grant to OIDC/PKCE against MAS.

> **IMPORTANT — sections 1–8 below describe the ORIGINAL password-grant design
> and are partially SUPERSEDED.** The authentication model in particular
> (§5 "Login: Matrix password grant", and the password-related parts of §2 and
> §7's provider seam) was replaced on 2026-06-14. See the new section **"9.
> OIDC migration (MAS / MSC3861)"** at the bottom for the current state. The
> architecture, session model (§4), and security guarantees (§6) remain
> accurate; only the login mechanism changed. Read §9 before acting on §5.

---

## 1. Purpose

fourier-auth gates access to media so that only users who can prove a valid Matrix
identity — and who have permission in Matrix to see a given image — can retrieve it. It
exists to close the gap that the booru currently serves media openly (/data/ static
files, no auth).

The design principle driving it: Danbooru stores metadata and a pointer (the MXC URI),
not the media bytes. All image bytes live in Synapse's R2 and are served through this
auth proxy, which enforces the viewer's Matrix permissions on every request. Synapse
remains the single authority for both storage and authorization.

---

## 2. Architecture

Browser (booru page) sends GET /media/<server>/<mediaId>?thumb=1 carrying the
fourier_session cookie. fourier-auth resolves the session cookie to a Matrix token via
fourier-redis, then calls the Synapse authenticated media API with that token. Synapse
enforces that the token is valid AND the user shares the room the media is in, returning
the image bytes (streamed back) or 401/403 if not permitted.

Key property: the Matrix token is never exposed to the browser. The browser only ever
holds an opaque session id (cookie); the token lives server-side in Redis.

### Provider seam (future-proofing)

Login is structured behind a provider interface (providers.js). A provider authenticates
a user and yields { matrixUserId, matrixToken }. Matrix (password grant) is the first and
currently only provider. Future providers (SSO/OIDC, other platforms) implement the same
shape, so the session and gate layers never need to know which provider was used. This
keeps the architecture dynamic for Fourier's planned multi-platform growth.

---

## 3. Files

All under /opt/fourier/auth/:

- index.js — Express app: /healthz, /login, /logout, and the /media/... proxy gate
- session.js — Redis-backed sessions: create, resolve, destroy; opaque id -> Matrix token
- providers.js — Provider interface + MatrixProvider (password grant against Synapse /login)
- redis/docker-compose.yaml — Dedicated fourier-redis (ephemeral, capped, loopback-only in dev)
- DEPENDENCIES.md — Cross-cutting version/dependency manifest for the whole stack
- package.json / package-lock.json — Node deps: express, ioredis, axios, cookie-parser

---

## 4. Sessions

- Opaque session id = 32 random bytes (crypto.randomBytes), unguessable.
- Stored in Redis as session:<id> -> { matrixUserId, matrixToken, createdAt }.
- TTL: 24h default (SESSION_TTL), auto-expiring in Redis.
- The browser cookie (fourier_session) is httpOnly, sameSite=lax.
- Logout (/logout) deletes the Redis key and clears the cookie — proven to immediately
  revoke media access.

### fourier-redis

- redis:7-alpine, dedicated instance, its own fourier-redis_net network.
- Ephemeral: persistence disabled (--save "" --appendonly no). A restart logs everyone
  out (acceptable) and avoids storing Matrix tokens on disk.
- Capped: --maxmemory 256mb --maxmemory-policy allkeys-lru.
- Not host-published in production — only a loopback port (127.0.0.1:6379) for host-based
  dev. Remove/keep loopback-only once auth is containerized.

---

## 5. Login (current: Matrix password grant)

- POST /login with { provider?: "matrix", username, password }.
- MatrixProvider calls Synapse /_matrix/client/v3/login (m.login.password), with
  initial_device_display_name "Fourier" so these sessions are identifiable in the user's
  Matrix device list.
- On success: returns { matrixUserId, matrixToken, deviceId }, a session is minted, the
  cookie is set.
- On failure: Synapse's error is passed through as 401.

Acknowledged limitation: the user types their Matrix password into a Fourier form, which
means Fourier sees it in transit (not stored). Acceptable for trusted/admin users; to be
replaced by an SSO/OIDC provider before opening to general users.

---

## 6. What was proven (host testing)

Tested on the host AND container-to-container (from inside a Danbooru container,
the path the integration will use) against the live Synapse and fourier-redis:

- Valid login -> session -> thumbnail fetch: 200, correct JPEG.
- Valid session -> full image fetch: 200.
- Synapse thumbnail endpoint confirmed working and auth-gated (the design hinge — means
  no resizer needs building; Synapse generates thumbnails).
- Security guarantees verified:
  - No cookie -> 401
  - Bogus session id -> 401
  - Valid session but invalid underlying token -> 401 (Synapse refuses)
  - Wrong password -> 401, no session minted
  - After logout, previously-valid session -> 401

---

## 6b. Containerization

- Image: node:22-slim, production deps only. Container name `fourier-auth`.
- Joins three external networks: synapse_default (reach Synapse), danbooru_default
  (reached BY Danbooru's nginx as http://fourier-auth:8010), fourier-redis_net (reach Redis).
- Config via environment: SYNAPSE_URL=http://synapse:8008, REDIS_URL=redis://fourier-redis:6379,
  PORT=8010, SESSION_TTL=86400. No host port published.
- fourier-redis loopback port (127.0.0.1:6379) removed now that auth reaches Redis over the
  internal network. Redis is fully internal, no host exposure.
- Proven container-to-container from inside danbooru-danbooru-1: health (redis:true), login,
  and gated thumbnail fetch all 200 over the Docker network.

---

## 7. Deferred / what's next

1. Wire Danbooru's image URLs to the gate (Step 5). The remaining integration. Requires
   modifying Danbooru's OpenResty config so /data/ (currently open static files mapped to
   /images/) routes through fourier-auth instead, and rewriting how Danbooru renders image
   URLs to point at the gate keyed by MXC. Most invasive part — modifies third-party
   software, not Fourier's own code.
2. Device cleanup on logout/expiry. Every login creates a new Matrix device. Logout (and
   ideally session expiry) should call Synapse logout to invalidate that device/token, or
   the user's device list accumulates "Fourier" entries indefinitely.
3. SSO/OIDC provider. Replaces password-grant for general users; slots in behind the
   existing provider seam without touching session/gate code.
4. Map post -> MXC at request time. The gate currently takes server/mediaId directly; the
   Danbooru integration needs to resolve a booru post to its MXC and produce gate URLs.

---

## 8. Operational reference

Auth service (host dev):
  cd /opt/fourier/auth
  SYNAPSE_URL="http://127.0.0.1:8008" REDIS_URL="redis://127.0.0.1:6379" PORT=8010 node index.js

fourier-redis:
  cd /opt/fourier/auth/redis
  docker compose up -d
  docker compose ps

Health:
  curl -s http://127.0.0.1:8010/healthz   (-> {"status":"ok","redis":true})

- Synapse authenticated media endpoints used:
  /_matrix/client/v1/media/download/<server>/<id> and .../thumbnail/<server>/<id>
- Session cookie: fourier_session (httpOnly)
- Default ports: auth 8010 (dev), redis 6379 (loopback dev only)

## 9. Bearer mode + public gateway — mxc.41chan.net (2026-06-26)

Added a second way into the /media token broker so first-party clients (Technetium)
use the gate without a fourier_session cookie, and exposed the gate publicly.

Code (index.js):
- /media/:serverName/:mediaId resolves the upstream Matrix token from EITHER
  `Authorization: Bearer <MAS token>` (header wins) OR the fourier_session cookie.
  Synapse stays the final authority (invalid token 401s through). Booru cookie
  path unchanged — additive, backward-compatible.
- CORS: new CLIENT_ORIGINS env (comma-separated allow-list); applyMediaCors()
  reflects ACAO for listed origins + OPTIONS preflight. Header-based, so NO
  Allow-Credentials (no cross-origin cookies).

Compose / deploy:
- ports ["127.0.0.1:8010:8010"] (loopback publish; matches every other service).
- CLIENT_ORIGINS=http://127.0.0.1:5173 (Technetium dev).

Ingress:
- Caddy (HOST systemd process, not in the Docker stack):
  mxc.41chan.net { reverse_proxy localhost:8010 }  — LE cert auto-provisioned.
- Cloudflare DNS: mxc.41chan.net, proxied.

Verified: unauth -> 401 {"error":"no valid session or bearer token"};
valid Bearer -> 200 image/jpeg; ?w=320 snaps to ALLOWED_THUMB_SIZES.

Note: public route is /media/:server/:id?w=<px>, distinct from the upstream
Synapse paths (/_matrix/client/v1/media/{download,thumbnail}) the gate proxies to.

---

Development log for the fourier-auth build.

---

## 9. OIDC migration (MAS / MSC3861) — 2026-06-14

**Supersedes the password-grant auth described in §5 (and the password parts of
§2 and §7).** The session model (§4), the gate architecture (§2's proxy
behavior), and the security guarantees (§6) are unchanged and still accurate.

### Why this changed

The homeserver was migrated to delegate authentication to
matrix-authentication-service (MAS) under MSC3861 (see the separate
`MAS_DEVLOG.md` in /opt/synapse/). Once Synapse delegates auth, it no longer
honors the legacy `m.login.password` grant that `MatrixProvider` relied on —
fourier-auth's password login began returning 401 for valid credentials. This
forced (and enabled) the move to a proper OIDC redirect flow, which had always
been the intended end state: the original §5 explicitly flagged the
password-in-transit model as a stopgap "to be replaced by an SSO/OIDC provider."
That concern is now resolved — fourier-auth never sees a password.

### What the provider seam bought us

The provider abstraction (§7) paid off exactly as designed: the session and gate
layers did not change at all. Only `providers.js` (new provider) and the
`/login` + `/callback` routes in `index.js` changed.

### New flow (Authorization Code + PKCE)

1. `GET /fourier/login` → builds a MAS authorize URL with PKCE, stashes the
   state + code_verifier in Redis (single-use, 10-min TTL), and redirects the
   browser to MAS.
2. User authenticates at MAS (`auth.41chan.net`) and consents.
3. MAS redirects to `GET /fourier/callback?code=&state=`.
4. fourier-auth validates state, exchanges the code at MAS's token endpoint
   (with the code_verifier), and receives an access token.
5. **The MAS access token is a valid Matrix token under MSC3861.** A
   `whoami` call resolves the user id; a session is minted exactly as before;
   the gate uses the token against Synapse's authenticated media API unchanged.

### Code changes

- `providers.js`: added `OidcProvider` — `discover()` (lazy
  `.well-known/openid-configuration`), `authUrl()` (PKCE S256 challenge,
  scope `openid urn:matrix:org.matrix.msc2967.client:api:*` — the scope is what
  makes MAS issue a Matrix-API-capable token), and `exchange()` (code → token →
  whoami). Hand-rolled with `axios` (no new dependency). `MatrixProvider`
  retained but **non-functional under delegation** — slated for removal.
- `index.js`: `/login` changed from `POST` (JSON) to `GET` (redirect); added
  `GET /callback`. Session-minting and the media gate are byte-for-byte the same.
- `session.js`: added `putOidcState`/`takeOidcState` (single-use Redis storage
  for in-flight PKCE state) and a Redis `error` handler. The handler carries a
  comment explaining the expected host-side `ECONNREFUSED` spam when the module
  is load-tested on the host before containerization (Redis is internal to the
  Docker network; not a fault — use `node --check` to load-test without
  connecting).

### Config / secrets

- OIDC client credentials are supplied via environment, sourced from a
  **gitignored `.env`** via compose substitution (`${OIDC_CLIENT_ID}`,
  `${OIDC_CLIENT_SECRET}`) — NOT hardcoded in the tracked `docker-compose.yaml`.
  Env vars: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_REDIRECT_URI`, `POST_LOGIN_REDIRECT`.
- The fourier-auth client is statically registered in `mas/config.yaml`
  (id, secret, redirect `https://booru.41chan.net/fourier/callback`).

### Gotchas encountered

- **Stale build / mislaid file:** an early edit of `providers.js` was written to
  the wrong working copy; the build faithfully shipped the old file and `/login`
  threw "Cannot read properties of null (reading 'authUrl')" (provider not
  registered). Verify edits landed on the file the build's `COPY` reads
  (`realpath providers.js`), and confirm the running container has them
  (`docker compose exec auth grep -c "oidc: OidcProvider" providers.js`).
- **Consent-screen client name:** shows the raw client ULID, not "Fourier", due
  to upstream MAS issue #4415 (static clients' `client_name` not synced).
  Worked around by a sidecar in the Synapse stack — see `MAS_DEVLOG.md` §7.

### Deferred (updated)

- Remove `MatrixProvider` (dead under delegation).
- Device cleanup on logout/expiry — now MAS-managed; confirm behavior.
- The original §7 "deferred" list's items 1 (wire Danbooru's image URLs) is
  DONE (the chanbooru fork's media-gating routes through this gate); item 3
  (SSO/OIDC provider) is DONE (this section).

---

## 2026-06-28 — Per-room media authorization (the §9 leak, closed)

### The vulnerability
A logged-in user could fetch ANY media by mxc, regardless of room membership.
Confirmed live: `@notsaber` (member of no content rooms) fetched a private
room's image and got `200` + bytes, while `/messages` for that same room
correctly `403`'d. The bytes rendered in a fresh browser. Real exposure.

### Root cause — NOT a fourier-auth or client bug
fourier-auth forwards the user's own token to Synapse's authenticated-media
endpoint (`/_matrix/client/v1/media/download`) and trusts Synapse's verdict —
correct delegation. The gap is in SYNAPSE: authenticated media (MSC3916)
authenticates the *token* but does NOT enforce per-room membership. It killed
anonymous media URLs; it did NOT add per-room ACLs (a deliberate spec scoping
decision — per-room media authz across federation is hard, so it's left to the
application layer). So any valid token fetches any mxc. This is a Synapse
PROPERTY, by design.

LESSON (record loudly): "authenticated media" != "authorized media." The
intuition that Synapse would not serve restricted media to a non-member is
WRONG. A future Synapse-upgrade session will have the same intuition — this
note exists so they don't re-derive it.

### The model (confirmed canonical)
A user may fetch a piece of media IFF they are joined to >=1 Matrix room that
contains it. Applies UNIFORMLY to clients (bearer) and the booru (cookie) — the
booru grants no access room membership wouldn't. "Visible-if-visible-anywhere":
if the same bytes are in any room you can see, you can fetch them (content
identity is by mxc; aligns with booru MD5 dedup). This is just reality — if
bytes are public anywhere, they're public.

### The fix — `mediaauth.js` (Option A)
New module gating GET /media before the upstream fetch:
- `resolveMediaRooms(mxc)` -> which rooms contain this mxc. Read DIRECTLY from
  Synapse Postgres: `events JOIN event_json ON event_id WHERE type='m.room.message'
  AND json::jsonb #>> '{content,url}' = mxc`. Cached (mediarooms:<mxc>, 6h —
  an mxc's room set is immutable once posted). Only non-empty results cached.
- `getJoinedRooms(token)` -> `GET /joined_rooms` with the USER'S OWN token.
  Token-scoped, no admin, no user_id needed (dropped whoami — the token IS the
  identity). Cached (userrooms:<sha256(token)>, 5m).
- Allow IFF (mxc's rooms) ∩ (user's joined rooms) != empty. Else 403.
- FAIL CLOSED on any error or empty resolution.

### Why DB-coupling (accepted deliberately)
Matrix exposes NO media->room lookup in the client API (verified against spec).
mxc is content-addressed, decoupled from rooms by design. So the mxc->room half
unavoidably needs a privileged read. The caller's own token can't do it (a
non-member can't read a room's events). Options were: build+maintain a parallel
index (the §4.1 design), or read Synapse's DB (which IS that index, already
populated). We read the DB.

COUPLING NOTE (the reason this is documented): the resolver query depends on
Synapse's schema (`events`/`event_json`, `json::jsonb #>> '{content,url}'`). A
Synapse upgrade that changes that shape BREAKS the query — but LOUDLY (resolver
error -> fail-closed -> media stops, very visible), not silently. When that
happens, the fix is to re-check the schema, not to re-investigate the whole
authz model. Swap for a built index (bmb-owned mxc->rooms) later if the coupling
ever bites; `resolveMediaRooms()` is the single swappable seam.

REJECTED earlier resolver sources, for the record:
- `net.41chan.media.tags` state (bmb tags): covers ~11/283 media — bmb is only
  in one unused room. NOT a viable resolver; would 403 ~96% of legit media.
- Synapse admin API: no clean "rooms containing this mxc" endpoint exists.

### Infra
- Dedicated read-only role `fourier_auth_ro`: LOGIN NOSUPERUSER, `SELECT` on
  `events`,`event_json` ONLY. Write attempts correctly denied. Password in
  gitignored `.env` (Compose `${SYNAPSE_DB_PASSWORD}` substitution, matching the
  OIDC secret pattern). Reaches Postgres over the shared `synapse_default`
  network (no new network/port needed).
- `pg` added to deps; `mediaauth.js` added to Dockerfile COPY; cache helpers
  (`cacheGetJson`/`cacheSetJson`) added to session.js reusing its redis client.

### Verified live (through mxc.41chan.net gateway)
non-member -> 403 | member -> 200 | member thumbnail -> 200 | no token -> 401.
The leak is closed; legit access intact; booru cookie path unchanged.

### Avatars — NOT in scope (verified)
Avatars do not traverse this gateway: Technetium resolves member avatars via
`getMxcAvatarUrl()` (Synapse client API), only `m.image` MESSAGE events hit
/media. So fail-closed gating doesn't break avatars. (Future idea: serve avatars
locally on 41chan — public, tiny, fetched once — instead of via R2/gateway.)

---

## 2026-07-01 -- /media originals: presigned direct-download JSON (byte-proxy superseded)

The gate no longer streams LOCAL original bytes. After the same per-room
authz (mediaauth.js, unchanged), GET /media/:server/:id without ?w= returns
200 application/json { "url": <SigV4-presigned GET, 300s TTL> } and the
client fetches bytes from object storage directly; the origin serves only
the ~500 B envelope (Cache-Control: no-store -- a short-lived signature
must not be cached and replayed stale).

- A 302 redirect was tried first and abandoned: a browser fetch() following
  a cross-origin redirect taints Origin to "null", which bucket CORS cannot
  allowlist. JSON + plain <img src> on the client removes CORS from the
  byte leg entirely (cross-origin <img> is unrestricted; the URL
  self-authorizes).
- Key derivation is pure string work on the media ID (storage mirrors the
  Synapse media-store layout, local_content/AA/BB/rest) -- no DB coupling
  added.
- Presign: @aws-sdk/client-s3 + s3-request-presigner, region "auto"; R2
  requires SigV4. ResponseCacheControl override "private,
  max-age=31536000, immutable" on the signed GET -- stored objects carry
  no Cache-Control, so browsers would otherwise re-download originals on
  every view.
- Presign failure falls back to the old Synapse proxy (delivery fallback;
  authz already passed, not a bypass).
- Scope: LOCAL originals only (HOMESERVER_NAME env). Thumbnails + remote
  media still proxy (Synapse generates thumbnails lazily; they may not
  exist in storage). The proxy branch now FORWARDS Synapse's Cache-Control
  (public,max-age=86400,s-maxage=0,proxy-revalidate) instead of dropping
  it: browser caching restored; s-maxage=0 still blocks shared/edge
  caching (an edge HIT would bypass per-room authz).
- Bucket CORS (GET/HEAD, first-party client origins) applied via the
  provider dashboard -- object-scoped API tokens get AccessDenied on
  bucket-config writes.
- New env: R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  (gitignored .env); R2_BUCKET / R2_PRESIGN_TTL / HOMESERVER_NAME
  (compose). New deps: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner.

Open: service token is read-write but only needs read+presign; thumbnail
egress still proxies; local purge after offload remains unbuilt.
