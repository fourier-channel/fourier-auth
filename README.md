<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-auth/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# Fourier — Auth

Platform-gated media authorization and token broker for the Fourier project.

fourier-auth gates access to media so that only users who can prove a valid Matrix identity
— and who have permission in Matrix to see a given image — can retrieve it. It is the
access-control layer that lets a metadata store (e.g. Danbooru) reference media without
storing or exposing the bytes: all media is served through this proxy, which enforces the
viewer's Matrix permissions on every request via Synapse's authenticated media API.

Fourier is an umbrella project for targeted data aggregation, classification, and storage.
Auth is one component; see also fourier-bmb (the Booru-Matrix Bridge).

---

## How it works

1. A user logs in by proving a Matrix identity. A server-side session is created in Redis
   mapping an opaque session id (the browser's cookie) to the user's Matrix access token.
2. When the user requests an image, the browser sends only the session cookie.
3. fourier-auth resolves the cookie to the Matrix token (server-side; the token is never
   exposed to the browser) and calls Synapse's authenticated media API with it.
4. Synapse enforces that the token is valid and that the user shares the room the media is
   in, returning the bytes or refusing (401/403). The proxy streams the result back.

Synapse remains the single authority for both storage and authorization. An exposed MXC URI
is only a pointer; it grants no access without a valid, permitted Matrix token.

---

## Status

Live. Containerized and integrated end to end: the chanbooru (Danbooru fork)
media-gating routes image requests through this gate, and authentication uses an
OIDC Authorization Code + PKCE flow against matrix-authentication-service (MAS).
The earlier Matrix password-grant login has been retired (the homeserver now
delegates auth to MAS under MSC3861, which no longer accepts that grant). See
DEVLOG.md for the migration detail and the deferred roadmap.

**2026-06-26 update:** the gate now also accepts an `Authorization: Bearer`
MAS token (alongside the `fourier_session` cookie), so first-party clients
(e.g. Technetium) use it directly. It is publicly reachable at
`https://mxc.41chan.net` (route `GET /media/:serverName/:mediaId`, thumbnails
via `?w=`). See DEVLOG.md §9.

---

## Requirements

- A working Synapse homeserver with enable_authenticated_media: true.
- A matrix-authentication-service (MAS) instance acting as the OIDC provider,
  with a client registered for this service (client id/secret + the redirect URI
  below). See MAS_DEVLOG.md in the Synapse stack.
- Redis (a dedicated, ephemeral instance is provided under redis/).
- Node 22 (no nedb-class constraint; unlike fourier-bmb this is not pinned to Node 20).

---

## Configuration (environment variables)

- SYNAPSE_URL — base URL of the homeserver (e.g. http://synapse:8008).
- REDIS_URL — e.g. redis://fourier-redis:6379 (or redis://127.0.0.1:6379 for host dev).
- PORT — listen port (default 8010).
- SESSION_TTL — session lifetime in seconds (default 86400).
- OIDC_ISSUER — MAS issuer URL (e.g. https://auth.41chan.net/).
- OIDC_CLIENT_ID — this service's client id registered in MAS.
- OIDC_CLIENT_SECRET — the corresponding client secret.
- OIDC_REDIRECT_URI — the callback, e.g. https://booru.41chan.net/fourier/callback.
- POST_LOGIN_REDIRECT — where to send the user after a successful login.
- CLIENT_ORIGINS — comma-separated browser origins allowed to call the media
  proxy cross-origin with a Bearer token (CORS allow-list; e.g. a dev client
  at http://127.0.0.1:5173). Empty/unset = no cross-origin clients.

The OIDC client credentials are secrets: supply them via a gitignored `.env`
(compose substitutes them in), not hardcoded in docker-compose.yaml.

---

## Running

In production this runs as a container in the Synapse compose stack (see
docker-compose.yaml), with OIDC credentials supplied from a gitignored `.env`.

For host/development, start the dedicated Redis:

    cd redis
    docker compose up -d

Then start the service with the required environment (OIDC vars included):

    SYNAPSE_URL="http://127.0.0.1:8008" \
    REDIS_URL="redis://127.0.0.1:6379" \
    PORT=8010 \
    OIDC_ISSUER="https://auth.41chan.net/" \
    OIDC_CLIENT_ID="..." OIDC_CLIENT_SECRET="..." \
    OIDC_REDIRECT_URI="https://booru.41chan.net/fourier/callback" \
    POST_LOGIN_REDIRECT="https://booru.41chan.net/" \
    node index.js

Health check:

    curl -s http://127.0.0.1:8010/healthz

---

## API

- GET /login — begins the OIDC flow; redirects the browser to MAS to
  authenticate. (No credentials are posted to this service.)
- GET /callback — the OIDC redirect target; exchanges the authorization code,
  mints the session, sets the cookie, and redirects to POST_LOGIN_REDIRECT.
- POST /logout — destroys the session and clears the cookie.
- GET /media/<server>/<mediaId> — proxies the full image (auth required).
- GET /media/<server>/<mediaId>?w=<px>&h=<px> — proxies a thumbnail at the
  nearest allowed size (auth required). Legacy ?thumb=1 also accepted.
- GET /healthz — service + Redis health.

---

## Providers

Login is structured behind a provider interface (providers.js). A provider authenticates a
user and yields { matrixUserId, matrixToken }. The active provider is **OIDC**: an
Authorization Code + PKCE flow against MAS. Because MAS issues tokens that are valid Matrix
tokens (MSC3861), the gate uses the token from the OIDC exchange directly against Synapse's
authenticated media API — no separate Matrix login is needed.

A legacy MatrixProvider (direct password grant) remains in the code but is non-functional
now that the homeserver delegates auth to MAS, and is slated for removal. The provider seam
means session and gate layers are unaffected by which provider is used — adding the OIDC
provider required no changes to either.

Because login is now a redirect to MAS, the user's password is entered only at MAS and is
never seen by this service — resolving the password-in-transit limitation of the original
design.

---

## Security notes

- Matrix tokens are stored server-side in Redis, never exposed to the browser.
- fourier-redis is ephemeral (no disk persistence) so tokens are not written to disk; a
  restart simply logs users out.
- The session cookie is httpOnly.
- Authenticated media must be enabled on Synapse for the gating model to hold.

---

## Credits

Code written by Claude (Anthropic). The human counterpart paid the electric bill and
asked the right questions.

---

## License

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See LICENSE.

If you run a modified version of this software as a network service, the AGPL requires you to
make your modified source available to its users. The copyright holder may also offer
commercial licensing terms separately.
