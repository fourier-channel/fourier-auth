<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-auth/worker/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# fourier-media Worker

Serves Matrix media to Element without 41chan touching the bytes.

## Why it has to be a Worker

Element fetches media from `matrix.41chan.net/_matrix/client/v1/media/*` with
the user's access token. Synapse answers by streaming the bytes -- from local
disk, or from R2 once the local copy is purged. Either way they cross 41chan,
and they must not.

Nothing running **on** 41chan can fix this, because anything running on 41chan
is in the path by definition. Synapse cannot be made to redirect either: the
installed `s3_storage_provider` exposes only `fetch()`, with no redirect hook,
and this Synapse's media module has no storage-provider redirect path. The only
place left to stand is Cloudflare, which already fronts the hostname.

The other two media paths were fixed without a Worker and are already live:
fourier-auth 302s every class to R2, and `media-r2-purge` clears the local
store. This is the third and it is the only one that needs deploy access.

## What it does

    Element ---(Bearer token)---> Worker
    Worker  ---(same token)-----> fourier-auth   "may this token see this, and where?"
    Worker  ---(presigned URL)--> R2             the image, never over 41chan
    Worker  ---(bytes)----------> Element

Authorization is delegated to fourier-auth, which already answers exactly that
question for exactly this token shape, including the per-room membership check
MSC3916 leaves out. Reimplementing that here would be a second copy of the rule
deciding who may see what -- the most dangerous thing in this system to have two
of. Only the decision crosses 41chan (a few hundred bytes); the image does not.

Bytes are edge-cached keyed on the R2 object, and the cached copy is marked
public-immutable in Cloudflare's shared cache: two authorized readers share
one copy, and an unauthorized one never reaches the line that serves it.
**Allows are cached at the edge for 240 seconds** (operator ruling
2026-08-16), keyed on a hash of the credential plus the authorization URL;
denials are never cached. A user who leaves a room can read for at most
four more minutes.

Only a path the Worker does not recognise is passed to the origin untouched.
Everything it does recognise fails CLOSED: a denial, an unreachable gate, or
an R2 miss answers 401, 403 or 502 with no origin fallback. The earlier
"pass through on doubt" behaviour leaked what fourier-auth denied, and was
reversed.

Every response carries `X-Content-Type-Options: nosniff` and a
`Content-Disposition` decided by content type against an inline-safe list,
so an uploaded HTML file cannot execute in the viewer's origin. The OPTIONS
preflight is answered before any authorization check. Each decision is
logged as `{path, kind, ok, authStatus}` with no token material, so a no-op
Worker cannot look like a working one.

Two non-secret variables shape it: `FOURIER_AUTH_BASE` (where the gate is)
and `CREDENTIALED_ORIGINS` (sibling origins that get their Origin echoed with
`Allow-Credentials: true` instead of the wildcard).

## Deployed

Live since 2026-08-15, version `0bc7e167`, on
`matrix.41chan.net/_matrix/client/v1/media/*`.

Since 2026-09-06, version `461c78f1`, ALSO on
`booru.41chan.net/fourier/booru/*` (operator ruling: the presigned X-Amz URL
the gate 302s to was the same mess on a second surface, now mounted inside
Technetium). Same shape, cookie-authorized: the Worker asks the gate with
the reader's cookies (a Bearer wins when both are present) and streams the
object; `?dl=1` is answered as an attachment named by the file, on the booru
route and on Matrix downloads alike. Two further Worker commits landed the
same day, so the version above is the first of that deploy, not the last.
Deployed from the box as root with the command below (wrangler 3 via npx;
nothing is installed in the checkout).

Verified by measuring the thing that matters rather than the status code: five
authenticated fetches returned 200 with bytes identical to the uploaded
original, and **Synapse's own media request count did not move** -- it served
none of them. Unauthenticated, bogus and wrong-kind tokens all get 401;
`/_matrix/client/versions`, `/_matrix/client/v1/media/config` and the admin
route are untouched.

The deploy token is at `worker/.env` (gitignored, 0600). It is an OPERATOR
credential -- it can push code to the zone -- and is never loaded by the running
service. Scopes it needs:

| scope | why |
|---|---|
| Account / Workers Scripts / Edit | upload the script |
| Zone / Workers Routes / Edit (41chan.net) | bind it to the media path |

No R2 binding and no DNS record are required -- it reaches R2 through the
presigned URL fourier-auth mints, and it attaches to a hostname that already
exists.

    cd /opt/fourier/auth/worker
    set -a; . ./.env; set +a
    export CLOUDFLARE_ACCOUNT_ID=$(grep -oP '(?<=^FS_CF_ACCOUNT_ID=).*' /etc/fourier-sampling/env)
    npx wrangler deploy

To roll back, delete the route in the Cloudflare dashboard or
`npx wrangler delete` -- Synapse serves the same paths the moment the Worker is
gone, so the fallback is the pre-change behaviour rather than an outage.

## Verifying it after deploy

The claim is "no media bytes cross 41chan", so measure that, not the status code:

    # before and after, from the origin's own view -- this must not move
    docker logs synapse-synapse-1 --since 10m 2>&1 \
      | grep -cE '"GET /_matrix/client/v1/media/(download|thumbnail)'

Then load a room in Element and confirm images render. If the count above rises,
the Worker is not intercepting and everything is falling through to the origin.

## Tests

    node --test media-worker.test.mjs

Tests over the pure decision logic: path recognition, the URL it asks
fourier-auth, how it reads the answer, the cache and fail-closed rules, and
what it hands the client. The count is whatever the command prints. They run
without Cloudflare, which is the point -- the logic was not going to ship on
faith just because it could not be deployed from here.
