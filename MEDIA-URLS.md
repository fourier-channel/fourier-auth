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
| booru-native original (`/booru/<md5>.<ext>`) | 302 to presigned R2 |
| local mxc original (`/media/<server>/<id>`) | 302 to presigned R2 |
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

## Known violations still open (2026-08-15)

Found while reverting an accidental fourth one. None were introduced by that
change; all predate it.

1. **Synapse holds 2.3 GB / 6,118 files of media at rest** in
   `/data/media_store` on local disk. `store_local: true` writes every upload to
   both disk and R2, and nothing ever removes the local copy -- `s3_media_upload`
   ships in the container but no cron or timer runs it. This is the direct
   "hold media" violation and it grows with every upload.
2. **Synapse serves those bytes** to every Element client on
   `matrix.41chan.net/_matrix/client/v1/media/*`. Emptying the local store does
   not fix this on its own: Synapse would fetch from R2 and still stream through
   this host.
3. **fourier-auth streams thumbnails and remote originals**: 3,724 thumbnail
   requests in 24h, measured from the booru's own nginx. The thumbnails already
   exist in R2 under `local_thumbnails/` (3,766 objects), so this path could be
   redirected the same way originals are.

Ordered by value: (1) is a deletion and needs an operator decision; (3) is a
contained change in this service; (2) is the one that actually needs the Worker.
