"use strict";

// GET /media/:serverName/:mediaId -- THE MATRIX DOOR. Its rules live here, with
// every dependency injected, so media-route.test.js can drive them end to end;
// index.js only wires them.
//
// Releases from R2 only (content-negotiated: a 302 to a presigned URL for
// native browser loads, or a JSON { url } envelope for fetch()/XHR callers --
// see release.js). The bytes go client <- R2, origin out of the path.
// Thumbnails: ?w=<px>&h=<px> (snapped to allowedThumbSizes), or legacy ?thumb=1 (320).
//
// The order of the questions:
//   1. who is asking: a token (Bearer, or a fourier_session's), or nobody
//   2a. a token: may its owner see a room holding this media (decideMediaAccess)
//   2b. nobody, or a token 2a refused: may a signed-out viewer see a booru
//       post holding this file (the public grant, below)
//   3. the quarantine, for both
//   4. the release from R2

const { BooruUnavailable } = require("./booru-visibility");
const { MediaAuthUnavailable } = require("./mediaauth-core");
const { matrixDoorVerdict, QuarantineUnavailable } = require("./booru-quarantine");
const { OriginalUnavailable, MEDIA_ID_RE } = require("./mediar2");

function makeMediaHandler(d) {
  return async function mediaHandler(req, res) {
    const { serverName, mediaId } = req.params;
    const path = `/media/${serverName}/${mediaId}`;
    const isLocal = serverName === d.homeserverName;

    let thumbSize = null;
    if (req.query.w || req.query.h) {
      const want = parseInt(req.query.w || req.query.h, 10) || 320;
      thumbSize = d.allowedThumbSizes.reduce((a, b) =>
        Math.abs(b - want) < Math.abs(a - want) ? b : a);
    } else if (req.query.thumb === "1") {
      thumbSize = 320;
    }

    d.applyCors(req, res);

    // Token broker, two ways in (Bearer header wins when present):
    //   Authorization: Bearer <MAS token> -> first-party clients (Technetium)
    //     that already hold the user's MAS token; header-based, so no cookie /
    //     SameSite friction cross-origin.
    //   fourier_session cookie             -> the booru's same-site path.
    // Synapse remains the final authority on validity: an invalid token earns a
    // 401 from the upstream media endpoint, which we pass straight through.
    let token = null;
    let viaSession = false;
    const authz = req.headers.authorization || "";
    if (authz.startsWith("Bearer ")) {
      token = authz.slice(7).trim();
    } else {
      const sid = req.cookies[d.cookieName];
      const session = await d.getSession(sid);
      // Through the token source, never session.matrixToken directly: the
      // session outlives its token by a day, and this is where it is renewed.
      if (session) { token = await d.freshToken(sid, session); viaSession = true; }
    }

    // The md5s the quarantine checks. A tokenless request learns them first,
    // to ask the booru; a token holder's are learned only at the quarantine.
    let md5s = () => (d.r2Enabled && isLocal ? d.localMd5s(mediaId) : []);
    let anonymous = false;

    // THE PUBLIC GRANT's question, asked for a tokenless request and for a
    // token the room check refused (both explained at the tokenless release
    // below). Only local media of a media id's shape can be asked about.
    // Resolves to the learned md5s when the booru says a signed-out viewer may
    // see a post holding this file, null when it says no, and false when it
    // could not be asked -- the 503 is then already sent.
    const grantable = d.r2Enabled && isLocal && MEDIA_ID_RE.test(mediaId);
    const publicGrant = async (who) => {
      let learned;
      try {
        learned = await d.localMd5sKnown(mediaId);
      } catch (err) {
        // The index could not be read (R2 failing): an md5 that cannot be
        // learned cannot be asked about. A retry, never a release.
        d.log.error(`[media] ${serverName}/${mediaId}: ${who} request could not learn its md5 -- refusing (fail closed): ${err.message}. ` +
          "Fix: check that R2 (R2_ENDPOINT, R2_BUCKET and its keys) is readable from this service; the client retries.");
        res.set("Cache-Control", "no-store");
        res.set("Retry-After", "2");
        res.status(503).json({ errcode: "M_UNKNOWN", error: "This image is being prepared; try again in a moment." });
        return false;
      }
      try {
        for (const md5 of learned) {
          if (await d.visibility.sees(md5, null)) return learned;
        }
        return null;
      } catch (err) {
        if (err instanceof BooruUnavailable) {
          d.log.error(`[media] BOORU UNREACHABLE -- refusing ${who} ${serverName}/${mediaId} (fail closed): ${err.message}. ` +
            "Fix: bring the booru's Rails app back at BOORU_INTERNAL_URL; the client retries.");
          d.signals.booruUnavailable(err.message);
        } else {
          d.log.error(`[media] ${who} ${serverName}/${mediaId}: the booru's answer could not be read -- refusing (fail closed): ${err.message}`);
        }
        res.set("Cache-Control", "no-store");
        res.set("Retry-After", "2");
        res.status(503).json({ error: "media authorization temporarily unavailable" });
        return false;
      }
    };

    if (!token) {
      // THE TOKENLESS RELEASE. Operator ruling 2026-11-01: "Images a user
      // places on their public gallery is considered a whitelist for those
      // posts that lets them through Gate 3 (specifically). Just as with all
      // other signed-out content, the authorizations are temporary."
      //
      // Gate 3 (GATE3_CONTRACTS.md) makes a Matrix post visible to exactly the
      // viewers its image is visible to, and a signed-out viewer saw none. The
      // booru now answers its ANONYMOUS ask (booru-visibility sees(md5, null))
      // for a Matrix post a signed-out visitor has been shown on a public
      // gallery, while that grant is fresh (a few hours, the booru's to set).
      // So this door asks the same question the booru door asks of a
      // signed-out reader, and releases what the booru says yes to -- through
      // the quarantine below, exactly as a token holder's would be.
      //
      // Local media only: only a local image has an md5 the booru can know it
      // by (mediar2.js localMd5s), and a remote one was never on a gallery.
      // And only an index that ALREADY EXISTS (d.localMd5sKnown: canon never
      // asked; review 2026-11-01). A tokenless request must cost nothing past
      // one index read -- asking canon is a POST that may run 30 s and makes a
      // real, not-yet-canonical id canonical for a stranger. A galleried image
      // was made canonical by the tunnel before it was posted, so it resolves;
      // an id no index names is a plain 401, its miss remembered 20 s.
      // Every other tokenless request gets the 401 it got before this ruling,
      // byte for byte -- a client cannot tell a refused stranger from one this
      // door never asked about.
      //
      // HOW LONG A REVOKED GRANT OUTLIVES THE BOORU'S ANSWER: the gate keeps an
      // anonymous yes for 120 s (booru-visibility.js TTL.visible), and the
      // edge Worker keeps a tokenless allow for 60 s (worker/media-worker.mjs
      // decisionTtl) -- about 3 min after the booru stops saying yes, the same
      // bound a just-jailed booru image has. The edge knows the allow is a
      // tokenless one because this door says so ({ url, anonymous: true },
      // release.js): from headers alone it would take a dead session's cookie
      // for a live one and keep the allow 150 s. A URL already handed over
      // lives its presign TTL, and bytes a browser already holds are its own.
      //
      // The answer is SHARED by every signed-out viewer: the booru's anonymous
      // ask is one answer for all of them, so while one visitor's grant is
      // fresh the image is open to every request carrying no token.
      //
      // A request WITH a token the room check refuses is asked the same
      // question below (operator 2026-11-01: the grant is "an unlock for gate
      // 3 on that specific view surface and not scoped to any given user").
      // An id that is not a media id's shape is refused before anything is
      // read for it: R2 rejects an over-long or odd key with an error, not a
      // miss, which would be a retry-forever 503 and an error line per
      // request carrying the stranger's text (review 2026-11-01).
      if (!grantable) {
        return res.status(401).json({ error: "no valid session or bearer token" });
      }
      const opened = await publicGrant("tokenless");
      if (opened === false) return;
      if (!opened) {
        d.signals.anonymousMatrixRefused(path);
        return res.status(401).json({ error: "no valid session or bearer token" });
      }
      md5s = opened;
      anonymous = true;
    } else {
      // Per-room authorization: Synapse authenticates the token but does NOT enforce
      // that the user can see the room this mxc lives in (MSC3916 scoping). Enforce
      // it here -- allow only if the token's owner is joined to a room containing
      // this media. Fail closed. Applies to BOTH bearer (client) and cookie (booru).
      // ?room_id= is the client saying which room it is rendering. It only ever
      // WIDENS access for media the server cannot see into (encrypted rooms), and
      // only when the caller is genuinely joined to the room named -- see
      // mediaauth.js for why knowing the mxc is itself evidence of membership.
      const roomId = typeof req.query.room_id === "string" ? req.query.room_id : undefined;
      let decision;
      try {
        decision = await d.decideMediaAccess(token, serverName, mediaId, { roomId });
      } catch (err) {
        if (!(err instanceof MediaAuthUnavailable)) throw err;
        // The gate could not be consulted. That is not "forbidden": the edge
        // renders 503 as an uncached 502 and the client retries with backoff.
        // Before this, a pool timeout was answered 403 -- final, and wrong -- 105
        // times a day (2026-09-05).
        d.log.error(`[media] authorization unavailable: ${err.message}`);
        res.set("Retry-After", "1");
        return res.status(503).json({ error: "media authorization temporarily unavailable" });
      }
      // Refused by the rooms, a token holder still gets what the public grant
      // opens to everyone -- released as a tokenless one is (anonymous: the
      // edge keeps it 60 s, not 150), so it can never outlive the grant
      // longer than a signed-out viewer's would.
      const opened = !decision.allowed && grantable ? await publicGrant("refused token holder") : null;
      if (opened === false) return;
      if (opened) {
        md5s = opened;
        anonymous = true;
      } else if (!decision.allowed) {
        // A reader who holds a session and is refused goes to the lamp WITH the
        // reason the gate refused: a dead token is red, an image in no room is
        // amber, a reader outside the image's room is the gate working. The
        // answer to the reader is the same 403 in every case -- the reason is for
        // the lamp, never the response, which must not say why.
        if (viaSession) d.signals.sessionRefused(403, path, decision.reason);
        return res.status(403).json({ error: "not authorized for this media" });
      }
    }

    // THE QUARANTINE, before anything is released (operator rulings 2026-10-12;
    // booru-quarantine.js). An image whose booru post carries a flagged or
    // banished tag, or troll_jail (jailed means deleted, shown nowhere), is
    // refused to EVERY Matrix reader, admins included -- this gate knows no
    // booru level for a Matrix token. Nor does the booru door open it: a Matrix
    // file passes there only when a visible, non-Matrix post holds it
    // (booru-route.js). A flagged Matrix post is reviewed in sampling's jail
    // panel, which reads R2 itself; the booru door's reviewer opening closed
    // 2026-10-15, when gate 3 went on.
    // Asked after the room check, so a reader outside the room still gets the
    // 403 and learns nothing. Checked by mxc, and for local media by every md5
    // its one file is known under (mediar2.js localMd5s, cached with canon's
    // index). The answer is the same "No such image." a gone image gets.
    try {
      const verdict = await matrixDoorVerdict({ quarantine: d.quarantine, serverName, mediaId, md5s });
      if (verdict === "refuse") {
        d.signals.quarantineRefused(path);
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ errcode: "M_NOT_FOUND", error: "No such image." });
      }
    } catch (err) {
      res.set("Cache-Control", "no-store");
      res.set("Retry-After", "2");
      if (err instanceof QuarantineUnavailable) {
        d.log.error(`[media] QUARANTINE UNREADABLE -- refusing (fail closed): ${err.message}`);
        d.signals.quarantineUnavailable(err.message);
        return res.status(503).json({ errcode: "M_UNKNOWN", error: "media authorization temporarily unavailable" });
      }
      // The image's md5 could not be learned (canon unreachable, the bucket
      // unreadable), so it cannot be cleared: the same 503 the original's own
      // release would give, never a release.
      d.log.error(`[media] ${serverName}/${mediaId}: quarantine check could not learn its md5 -- refusing (fail closed): ${err.message}`);
      return res.status(503).json({ errcode: "M_UNKNOWN", error: "This image is being prepared; try again in a moment." });
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
    // 404 below is then the answer, not a failure.
    let refusal = null;
    if (d.r2Enabled) {
      try {
        const key = await d.resolveR2Key({ serverName, mediaId, isLocal, thumbSize });
        if (!key) throw new Error("not in R2");
        // Only the edge Worker is handed the presigned URL (F-G2); a direct
        // caller is told the decision and nothing it could fetch with.
        const edge = d.isEdge(req.headers);
        const signed = edge ? await d.presign(key) : null;
        // Content-negotiated for the edge (see release.js for the full rationale
        // and the never-redirect-a-cors-fetch safety invariant); no-store always.
        // Counted here, past the quarantine and R2: a release is what was released.
        if (anonymous) (token ? d.signals.grantMatrixReleased(path) : d.signals.anonymousMatrixReleased(path));
        return d.sendRelease(req, res, signed, { edge, anonymous });
      } catch (err) {
        // An original with no stripped file is NEVER served from anywhere else.
        // Withheld: canon refused it, so there is no file without its prompt. Not
        // ready: canon could not be asked -- the client tries again; it never gets
        // Synapse's unstripped copy instead.
        if (err instanceof OriginalUnavailable) {
          res.set("Cache-Control", "no-store");
          if (err.code === "GONE") {
            return res.status(404).json({ errcode: "M_NOT_FOUND", error: "No such image." });
          }
          if (err.code === "WITHHELD") {
            d.log.warn(`[media] ${serverName}/${mediaId} withheld: ${err.message}`);
            return res.status(404).json({ errcode: "M_NOT_FOUND", error: "This image is withheld: its generation data could not be removed." });
          }
          d.log.error(`[media] ${serverName}/${mediaId}: ${err.message}`);
          res.set("Retry-After", "2");
          return res.status(503).json({ errcode: "M_UNKNOWN", error: "This image is being prepared; try again in a moment." });
        }
        // R2 could not answer: it does not hold the object (a remote user's
        // avatar from before federation was switched off, an upload still in
        // flight), or the presign failed. Either way the answer is the 404
        // below -- there is no other source. The reason rides on that one line.
        refusal = err.message;
      }
    }

    // NO PROXY FALLBACK. Operator ruling 2026-08-15: "There is no intended
    // fallback. None." and "41chan is not supposed to hold media or serve media
    // outside of site assets."
    //
    // This used to stream from Synapse whenever R2 could not answer -- for
    // thumbnails, for remote originals, and whenever a presign failed. Every one
    // of those was media bytes crossing this host, and worse, it meant a request
    // this gate had ALREADY AUTHORIZED could still be served from somewhere else,
    // so the gate's answer was never the last word. It is now.
    //
    // ONE line per refused request, saying REFUSED (2026-10-13). The catch above
    // used to log "R2 release unavailable ... proxying" before this line, from
    // the days a proxy followed it; a re-check read that as media streaming
    // through this host when nothing was.
    d.log.error(`[media] refused ${serverName}/${mediaId}: not in object storage${refusal ? ` (${refusal})` : ""}`);
    return res.status(404).json({ errcode: "M_NOT_FOUND", error: "media not in object storage" });
  };
}

module.exports = { makeMediaHandler };
