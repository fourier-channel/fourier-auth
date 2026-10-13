<!-- phase:S-736f6e -->
<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-auth/MEDIA-URLS.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# Media on 41chan: where the bytes may go

Operator ruling, restated 2026-08-15:

> 41chan is not supposed to hold media or serve media outside of site assets.

The host does not permit adult content. The constraint covers bytes **in
transit through** this machine, not only bytes **at rest** on it. That is the
same reason fourier-sampling's spool is a tmpfs rather than a directory.

This is easy to violate by accident, because every violation looks like an
improvement in the diff. Proxying media through the origin gives clean URLs,
better caching control and simpler code. It is still wrong here.

## The rule, applied

| path | correct behaviour |
|---|---|
| booru-native original (`/booru/<md5>.<ext>`) | to the edge Worker only: 302 or `{url}` to presigned R2 |
| local mxc original (`/media/<server>/<id>`) | to the edge Worker only: 302 or `{url}` to presigned R2 |
| either route, any caller without `MEDIA_EDGE_SECRET` | the decision, no URL (`released: false`) |
| anything a browser renders as an image | must not stream through this host |

`MEDIA_ORIGINAL_RELEASE` defaults to `redirect` for this reason and must stay
there on 41chan. `proxy` exists for a deployment where the constraint does not
apply.

### Why the presigned URL is ugly, and why that is not the thing to fix

It is an AWS SigV4 URL: `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`,
`X-Amz-SignedHeaders`, `X-Amz-Signature`. Every parameter is load-bearing --
the signature IS the authorization -- so there is no shorter form of it. The
real objection is not the length but that it is a bearer credential in a URL,
which lands in history, devtools and anything with page access.

The fix for that is NOT to proxy the bytes. It is to put a Cloudflare Worker in
front of R2 on its own hostname, where Worker->R2 stays inside Cloudflare and
41chan is not in the path at all. That gives clean URLs AND satisfies the
ruling; proxying gives clean URLs and breaks it.

A Worker MUST NOT simply authorize on a cookie and serve the bucket. One bucket
holds two separately-authorized sets (counted 2026-08-15):

| prefix | objects | rule |
|---|---:|---|
| `variants/`, `media/`, `thumbs/` | 51,205 | `fourier_session` |
| `local_content/`, `local_thumbnails/`, `remote_content/`, `remote_thumbnail/` | 6,039 | MXID + room membership |

A single cookie-authorized hostname over the whole bucket would make a booru
session sufficient to fetch every image posted in any Matrix room, DMs
included. Sessions are opaque Redis handles, not signed tokens, so the Worker
has to ask fourier-auth either way.

## 2026-09-06: both surfaces go through the Worker

The Worker described above has been in front of Matrix media since
2026-08-15. On 2026-09-06 the operator saw the same X-Amz URL on the booru
("open image in new tab"), a surface by then mounted inside Technetium, and
ruled that the same fix applies without being asked: the Worker now also owns
`booru.41chan.net/fourier/booru/*`, and Cloudflare answers the clean URL with
the bytes.

## 2026-10-01: the URL goes to the Worker and nowhere else

The leak audit found the gate itself answering anyone at `mxc.41chan.net`
with the presigned URL the Worker gets. The gate now releases it only to a
request carrying `MEDIA_EDGE_SECRET` (the Worker's secret of the same name);
everyone else is told the decision and handed nothing to fetch with. There
is therefore NO fallback if the Worker route is removed: a booru `<img>`
pointed at the origin gets a JSON decision, not a picture. That is
deliberate -- a fallback that works is a fallback that leaks.

The same audit closed bytes-by-md5 for booru media: the gate now asks the
booru whether a post the reader may see carries the md5, and serves nothing
for a jailed, deleted or never-posted image.

One more yes, ruled 2026-10-02: a published page is the operator's grant of
its thread's content for the life of the link. A live page sets
`fourier_pub_<hash>` on `/fourier/booru/`, and the gate releases an md5 the
booru would hide (a restricted-tag image) when that live page shows it,
checked with sampling and cached at most 60 s. Jailed images are redacted
from the page and never granted.

Same day, the booru session became zero-click from Technetium: `POST
/exchange` with a Bearer Matrix token from a listed client origin, proven by
Synapse's whoami, sets the same `fourier_session` cookie the OIDC callback
sets. See the memory `booru-signin-bridge`.

## 2026-10-09: a third route, for sampling's own host

Sampling moved from `booru.41chan.net/sample` to `sample.41chan.net`
(operator ruling 2026-10-09), and its external view and published pages
(`sample.41chan.net/p/<hash>`) name pictures root-absolute as
`/fourier/booru/<md5>...`. A page's `fourier_pub_<hash>` grant is host-only on
`/fourier/booru/`, so only a route on that host receives it: the Worker now
also owns `sample.41chan.net/fourier/booru/*` (worker/wrangler.toml), the same
shape as the booru route. Caddy answers that path on the sample host with a
404 that names the missing route, so a Worker without it shows as a fault, not
as the origin serving bytes.

## Known violations (re-checked 2026-10-13)

Three were recorded on 2026-08-15. Their state on 2026-10-13, measured
read-only on the production box:

1. **Media at rest on Synapse's disk -- RESOLVED.** Then 2.3 GB / 6,118 files
   in `/data/media_store`. Now EMPTY: no files in `local_content`,
   `local_thumbnails` or `remote_content`. The last 74 were empty (0-byte)
   placeholders unknown to Synapse's database -- 67 from matrix.org created
   2026-07-15, 7 from other servers created 2026-05-27 -- and were moved aside
   on 2026-10-13 to /var/lib/fourier/junk/2026-10-13-synapse-empty-remote-
   matrix-org/ (README there). Uploads are still written to disk and to
   R2 (`store_local: true`, `store_synchronous: true`), and
   `synapse-media-purge.timer` runs `/opt/synapse/tools/media-r2-purge
   --purge --min-age-days 1` daily: it frees a local file only after seeing
   it in a live R2 listing, and keeps anything unconfirmed. Recent runs freed
   about 18 files a day. Synapse's database still lists 1,128 local media
   (2.19 GB, all in R2) and 258 remote-cache rows (185 MB, none newer than
   2026-07-27). Not verified: that every one of those rows has an R2 object.
2. **Synapse serving media to clients -- RESOLVED for this route.** The edge
   Worker owns `matrix.41chan.net/_matrix/client/v1/media/*`
   (worker/wrangler.toml), asks this gate, and streams from R2, so the bytes
   no longer cross the homeserver on that path. Read from config, not from
   traffic.
3. **fourier-auth streaming thumbnails and remote originals -- NEARLY
   RESOLVED, measured 2026-10-13.** Recorded then as 3,724 thumbnail requests
   in 24h through this service. Thumbnails now resolve to their R2 rendition
   (mediar2.js lists the object's thumbnail prefix) and only the edge Worker is
   handed the URL. What still streams is the deliberate fallback for media R2
   does not hold ("[media] R2 release unavailable ... proxying" in this
   service's log): 37 requests in the last 24h, 78 in the container's 3 days
   of logs -- all for TWO remote items Synapse has rows for but neither its
   disk nor R2 holds (cutefunny.art, ~1 MB; matrix.org, ~750 KB), re-requested
   over and over. Open: get those into R2, or find why a re-fetch of remote
   media does not land there under the key this service resolves.
