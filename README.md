<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-auth/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# Fourier -- Auth

Media authorization oracle and session broker for the Fourier project.

fourier-auth decides whether a viewer may see a given Matrix image, and hands
out the means to fetch it. A viewer proves a Matrix identity once, by OIDC
against matrix-authentication-service (MAS) or by presenting a Bearer MAS
token; every image request after that is a permission question answered by
this service and a fetch of the bytes from R2, never through this service.
It is what lets a metadata store (the chanbooru fork) and a client
(Technetium) reference media without holding or exposing the bytes.

Fourier is an umbrella project for targeted data aggregation, classification,
and storage. Auth is one component; see also fourier-tunnel (the Booru-Matrix
Bridge) and technetium.

---

## How it works

1. A viewer authenticates. Either the browser completes an OIDC Authorization
   Code + PKCE flow against MAS and receives a `fourier_session` cookie
   (server-side session in Redis mapping the cookie to the MAS token), or a
   first-party client presents `Authorization: Bearer <MAS token>` directly.
   `POST /exchange` lets an allowed client origin turn a Bearer token into
   the same cookie, which is how the booru panel signs in with zero clicks.
2. On an image request, the service resolves the credential to a Matrix user
   and answers the question "may this user see this media?" by reading
   Synapse's own Postgres directly: which room the media was posted in,
   whether the user is joined, whether it is a site asset (avatar, room icon,
   emoji pack) that only needs a valid token. A reference to an mxc counts
   only when the image's uploader made it, or, for a message, when its sender
   has been in a room the uploader posted it to (a forward). Synapse's HTTP
   API is used only for `whoami` and `joined_rooms`. Synapse's
   authenticated-media endpoint is NOT used, because it authenticates the
   token but does not enforce room membership. Booru media asks a different
   authority -- the booru, whether a post the reader may see carries that
   md5.
3. If allowed, and the caller is the edge Worker (it proves that with
   `MEDIA_EDGE_SECRET`), the service presigns the object in R2 and answers
   with a 302 to that URL, or a JSON `{url}` envelope for cross-origin
   fetches (a redirect to R2 from a CORS fetch would arrive with a null
   origin). Any other caller gets the decision without a URL. It never
   proxies bytes; there is no fallback to proxying. Thumbnails resolve to an
   already-stored rendition in R2 at the nearest allowed size.
4. In production a Cloudflare Worker sits in front (see `worker/`): it asks
   this service for the decision, caches allows briefly at the edge, and
   streams the object from R2 itself. This service is then the oracle, not
   the path the bytes take.

Decisions are cached in Redis (site-asset, media-room and encryption facts
for six hours; joined rooms for five minutes, which is the revocation window;
booru post visibility for two minutes when visible and twenty seconds when
not), with single-flight coalescing, booru asks batched twenty md5s to a
query, and credentials hashed before they become keys.

Storage authority is R2. Authorization authority is this service. Synapse is
the source of the facts it reads.

---

## Status

Live, and in front of two surfaces: Matrix media for Technetium and the
booru, and booru-native originals and variants for chanbooru. Timeline:

- 2026-06: OIDC login against MAS; the password grant retired under MSC3861.
- 2026-06-26: Bearer MAS tokens accepted alongside the cookie.
- 2026-08-15: every media class released from R2 by presigned URL; the
  session cookie made site-wide.
- 2026-09-06: `POST /exchange` zero-click booru sign-in, `GET /booru/:file`,
  and the edge Worker on both hosts.

`DEVLOG.md` and `MEDIA-URLS.md` carry the detail; `DEVLOG.md` stops in
early July and the later changes are documented in code headers and in
`MEDIA-URLS.md`.

---

## Requirements

- A Synapse homeserver, with a **read-only Postgres role on Synapse's own
  database**. The service reads `profiles`, `events`, `event_json`,
  `current_state_events`, `local_media_repository` and `room_memberships`
  directly. It needs the four indexes in `db/synapse-indexes.sql` and the
  two grants in `db/synapse-grants.sql`; `tools/ensure-synapse-indexes.sh`
  applies and verifies both. Without the indexes every check is a sequential
  scan and the pool drains into 503s; without the grants every Matrix media
  decision fails with 503. The service checks both at boot, logs loudly if
  either is missing, and reports them on `/healthz`.
- The booru (chanbooru) reachable on the docker network, for booru media.
- An **R2 bucket** holding the media, with credentials that can presign.
- A MAS instance as the OIDC provider, with a client registered for this
  service.
- Redis (a dedicated, ephemeral instance is provided under `redis/`).
- Node 22.

---

## Configuration (environment variables)

Identity and sessions: `SYNAPSE_URL`, `HOMESERVER_NAME`, `REDIS_URL`, `PORT`
(default 8010), `SESSION_TTL` (seconds, default 86400), `COOKIE_DOMAIN`,
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`,
`POST_LOGIN_REDIRECT`.

**Client authentication to MAS.** Two ways, and the second is the one to use.

`OIDC_CLIENT_SECRET` is `client_secret_post`: the secret is sent in the body
of every token request. It is held by two parties, crosses the wire on every
login and every refresh, is readable by whatever terminates TLS, and has to be
rotated on both sides at once.

`OIDC_CLIENT_PRIVATE_KEY` is `private_key_jwt` (RFC 7523) and replaces it. A
PKCS#8 PEM -- literal newlines or `\n`-escaped, both accepted. The service
signs a 60-second assertion with it; MAS verifies against the matching PUBLIC
key in its own client config, and never holds a secret at all. Set
`OIDC_CLIENT_KID` to the key id so MAS can pick from a JWKS with more than one
key, which is what allows a key roll with no downtime.

When both are set the KEY wins, so a migration cannot silently keep sending
the secret. When neither is set the service refuses the request with a message
saying so, rather than sending an unauthenticated one and getting back a
refusal about something else.

Generate a pair with `node tools/make-client-key.js [kid]`: the private key
goes to stderr (put it in the offline secrets source), the public JWK to
stdout (paste into MAS's client block as `jwks`).

Worth knowing: MAS 1.22.0 verifies the assertion by SIGNATURE ONLY -- it reads
the client id from `sub` and does not enforce `aud`, `exp` or `jti`. The full
claim set is sent regardless, but the honest statement of the gain is "the
secret no longer travels", not "assertions cannot be replayed".

Authorization data: `SYNAPSE_DB_HOST`, `SYNAPSE_DB_PORT`, `SYNAPSE_DB_NAME`,
`SYNAPSE_DB_USER`, `SYNAPSE_DB_PASSWORD`, `SYNAPSE_DB_POOL_MAX`.

Bytes: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_PRESIGN_TTL`. Without the R2 variables every media request answers 404;
without the DB variables every media request answers 503.

`CLIENT_ORIGINS`: comma-separated browser origins allowed to call the media
routes cross-origin with a Bearer token, AND allowed to mint a session cookie
through `POST /exchange`. Adding an origin here is a session-issuance grant,
not a CORS tweak. Empty means no cross-origin clients.

`BOORU_MEDIA_REQUIRE_SESSION` (booru-native route needs a session, never a
Bearer) and `MEDIA_ORIGINAL_RELEASE` (leave at the default; `proxy` is an
escape hatch that must stay off here).

`BOORU_INTERNAL_URL` (default `http://danbooru:3000`): the booru's Rails app
on the docker network. `/booru/<md5>` serves an original or a variant only
when the booru's own posts API, asked as an anonymous reader (and, when that
says no, as the reader's own `_danbooru2_session`), returns a post carrying
that md5. Jailed, deleted and never-posted images answer 404. The booru being
unreachable is a 503, never a yes.

`SAMPLING_INTERNAL_URL` (default `http://172.18.0.1:5181`): Caddy's internal
door to fourier-sampling, which answers `/p/<hash>/data` and nothing else.
A published page is the operator's grant of its thread's content for the
life of the link (ruling 2026-10-02), restricted-tag images included; jailed
images never. A live page sets `fourier_pub_<hash>` on `/fourier/booru/`, and
when the booru says no to an md5, the gate asks for each such page's data (at
most eight, cached 60 s) and allows the md5 only if a live page shows it.
Sampling unreachable is a 503 for that path only.

`MEDIA_EDGE_SECRET`: the shared secret the Cloudflare Worker sends in
`X-Fourier-Edge`. Presigned R2 URLs are released only to a request carrying
it; every other caller of either media route gets the decision as
`200 {allowed: true, released: false}` with no URL, no 302 and no byte.
Unset means nobody is the edge: every picture behind the Worker fails, and
boot and `/healthz` say so. The Worker holds the same value as a Worker
secret of the same name.

`CANON_URL` (default `http://fourier-tunnel:8011`): fourier-tunnel's canon
service. Every local Matrix original is served as its ONE stripped file
(`media/<md5>.<ext>`, found through `index/local/<mediaId>.json`); an original
with no index entry yet is made canonical by asking canon before the gate
answers. There is no fallback to Synapse's own copy: canon unreachable is a
503, and an image canon refused is a 404 that says it is withheld.

Secrets go in a gitignored `.env`; `docker-compose.yaml` substitutes them.

---

## Running

In production this is a container beside the Synapse stack. For host
development you need Redis, a reachable Synapse Postgres role, and R2
credentials; a process started with only the OIDC variables answers 503 or
404 to every media request and serves only `/healthz`, `/login`, `/callback`
and `/verify`.

    cd redis && docker compose up -d
    set -a; . ./.env; set +a; node index.js
    curl -s http://127.0.0.1:8010/healthz

Tests: `npm test` (`node --test`: every `*.test.js` here and the Worker's `worker/*.test.mjs`; the count is whatever it prints).
`coherence.gate.yaml` declares the same. The Dockerfile copies `*.js` as a
glob on purpose: an explicit allowlist crash-looped the container three
times when a module was added.

---

## API

- `GET /login` -- begins the OIDC flow.
- `GET /callback` -- the OIDC redirect target; mints the session, sets the
  cookie, redirects to `POST_LOGIN_REDIRECT`.
- `POST /logout` -- destroys the session and clears the cookie.
- `POST /exchange` (and `OPTIONS`) -- from a `CLIENT_ORIGINS` origin, with a
  Bearer MAS token: validates it with Synapse and sets the same cookie the
  OIDC callback sets.
- `GET /verify` -- for the reverse proxy's auth subrequest: always 2xx; sets
  `X-Fourier-Identity` (the MXID) and `X-Fourier-Session-Info` when a valid
  session is present. The proxy must strip client-supplied copies of those
  headers; the booru trusts them.
- `GET /media/<server>/<mediaId>` (and `OPTIONS`) -- the decision plus a 302
  to a presigned URL or a `{url}` envelope. `?w=`/`?h=` snap to an allowed
  size (180, 320, 360, 720, 850); legacy `?thumb=1` means 320. Answers 403
  when denied, 503 with `Retry-After: 1` when authorization is unavailable
  (distinct from denied), 404 `M_NOT_FOUND` when R2 lacks the object.
- `GET /booru/:file` -- booru-native objects (`media/<md5><ext>`,
  `variants/<md5>/<size>` at 180, 360, 720), released only when a post the
  requester may see carries that md5 (asked of the booru), or when a live
  published page whose `fourier_pub_<hash>` cookie the reader holds shows it
  (asked of sampling); 404 otherwise, 503 when either cannot be asked;
  `?dl=1` signs a
  `Content-Disposition: attachment` into the presigned URL.
- `GET /healthz` -- the health document: level, checks, counts. Public
  callers get levels and counts only; a caller on the box or the tailnet that
  came through no proxy also gets each check's last-seen detail.

---

## Security notes

- MAS tokens are stored server-side in Redis, never exposed to the browser.
  Redis is ephemeral; a restart logs users out.
- The session cookie is httpOnly, secure, `SameSite=Lax`, and scoped to the
  whole site, so every first-party surface presents it.
- The one credential this design deliberately puts in a URL is the presigned
  R2 URL: several hundred bytes that land in the DOM, history and devtools
  for the presign TTL. `MEDIA-URLS.md` records why that trade was made.
- `?room_id=` widens the membership check only for genuinely encrypted rooms
  that the image's uploader has been a member of.
- Presigned URLs reach the edge Worker only (`MEDIA_EDGE_SECRET`). The gate
  is publicly reachable at its own hostname, and a direct caller there gets
  no URL, no redirect and no byte.

---

## Credits

Code written by Claude (Anthropic). The human counterpart paid the electric
bill and asked the right questions.

---

## License

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See
LICENSE.

If you run a modified version of this software as a network service, the AGPL
requires you to make your modified source available to its users. The copyright
holder may also offer commercial licensing terms separately.
