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

Bytes are edge-cached keyed on the R2 object. **Authorization is not cached** --
every request re-asks. A cached authorization is a user who left a room still
reading it.

Anything it does not recognise, or cannot get an answer for, is passed to the
origin untouched. A broken image for every user is worse than one byte crossing
the host, so the failure mode is the old behaviour, not an error.

## Deployed

Live since 2026-08-15, version `0bc7e167`, on
`matrix.41chan.net/_matrix/client/v1/media/*`.

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
| Account · Workers Scripts · Edit | upload the script |
| Zone · Workers Routes · Edit (41chan.net) | bind it to the media path |

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

Eleven tests over the pure decision logic: path recognition, the URL it asks
fourier-auth, how it reads the answer, and what it hands the client. They run
without Cloudflare, which is the point -- the logic was not going to ship on
faith just because it could not be deployed from here.
