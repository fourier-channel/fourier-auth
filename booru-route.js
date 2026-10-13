"use strict";

// GET /booru/:file -- booru-native media, as a handler with its dependencies
// injected, so the rules that decide who gets which bytes are tested without
// Redis, R2 or a booru (booru-route.test.js).
//
// ONE FILE, TWO DOORS, and this is the booru's. The order of the questions:
//
//   1. Is it a Matrix image's one file? Then it is refused UNLESS a post this
//      requester may see holds it in its own right -- visible, undeleted, and
//      not posted from Matrix (booru-visibility.js seesNonMatrix). A Matrix
//      image is served only through the Matrix door, which asks the room
//      (canon.js puts DM images in media/ too, under their md5). But one file
//      can be both: a 4chan image the booru already held, posted again in
//      Matrix, is adopted by canon as that Matrix image's one file. Refusing
//      on the Matrix record alone 404'd the booru post's original and every
//      thumbnail, silently -- thirteen live posts on 2026-10-05, post 1 since
//      2026-09-30. A refusal here is logged with its remedy and signalled.
//      A file released this way is that post's, so step 2 is already answered.
//      ONE MORE OPENING (operator ruling 2026-10-12): a FLAGGED post that came
//      from Matrix (booru-quarantine.js reviewable) is what an Admin reviews on
//      the booru, which hands them this door's address for it. Its file is
//      released to a reader whose OWN booru session sees that post -- asked as
//      them (booru-visibility.js readerSees), never anonymously, and only with
//      a session. Jailed, banished and unflagged Matrix files never open here,
//      and rooms (the Matrix door) still refuse a flagged one to everyone.
//   2. Does a post exist for this md5 that THIS REQUESTER may see? Asked of the
//      booru (booru-visibility.js). If not, does a LIVE published page the
//      reader holds the grant cookie for show it (publication-grants.js;
//      operator ruling 2026-10-02 -- a publication is his grant)? Neither ->
//      404, the same answer as "no such object", so the gate does not confirm
//      that a hidden image exists. Original AND variants: a thumbnail of a
//      jailed image is the jailed image. A grant never reaches an md5 in the
//      booru's QUARANTINE (a flagged or banished tag, or jailed; booru-quarantine.js,
//      operator rulings 2026-10-12): that is refused before the page is asked,
//      and an unreadable quarantine refuses the grant path with a 503. The
//      booru's own answer needs no such check -- it hides those posts itself.
//   3. For an original: is it still in the bucket? (moved to superseded/ -> 404)
//   4. Release: the presigned URL to the edge Worker only; everyone else gets
//      the decision without it (release.js sendRelease, callers.js).
//
// The booru being unreachable is a 503 with Retry-After, logged loudly and
// counted on the lamp: fail CLOSED. Serving bytes because the authority could
// not be asked is the leak this route was rewritten to close.

const { BooruUnavailable } = require("./booru-visibility");
const { PublicationsUnavailable } = require("./publication-grants");
const { QuarantineUnavailable } = require("./booru-quarantine");

function makeBooruHandler(d) {
  return async function booruHandler(req, res) {
    // Parsed rather than interpolated: this string becomes an object key, and
    // the gate is reachable by more than the booru. See booru-media.test.js.
    const parsed = d.parseBooruFile(req.params.file);
    if (!parsed) return res.status(400).json({ error: "bad media path" });

    d.applyCors(req, res);

    if (!d.r2Enabled) {
      // No Synapse fallback exists for these -- R2 is the only copy, by design.
      return res.status(503).json({ error: "R2 not configured" });
    }

    if (d.requireSession) {
      const session = await d.getSession(req.cookies && req.cookies[d.cookieName]);
      if (!session) return res.status(401).json({ error: "no valid session" });
    }

    const variant = d.pickVariant(req.query);
    const disposition = d.saveDisposition(parsed, req.query);
    const edge = d.isEdge(req.headers);

    // The reader, as the booru knows them: their own booru session, and the
    // address the Worker vouches for. Asked only when anonymous is refused.
    const booruSession = booruSessionAsSent(req, d.booruCookieName);
    const viewer = booruSession ? { sessionCookie: booruSession, clientIp: d.clientIp(req.headers) } : null;

    try {
      let ownPost = false;
      if (await d.isMatrixImage(parsed.md5)) {
        ownPost = await d.visibility.seesNonMatrix(parsed.md5, viewer);
        let unreviewed = "";
        if (!ownPost && viewer) {
          try {
            ownPost = d.quarantine.reviewable(parsed.md5) && (await d.visibility.readerSees(parsed.md5, viewer));
          } catch (err) {
            if (!(err instanceof QuarantineUnavailable)) throw err;
            // Not a 503: refusing is this door's answer for a Matrix file
            // anyway. Only a reviewer's opening is lost, and the quarantine's
            // own lamp is red.
            unreviewed = ` A reviewer's opening was not checked: ${err.message}.`;
          }
        }
        if (!ownPost) {
          const mxc = await matrixIdOf(d, parsed.md5);
          d.log.warn(
            `[booru-media] REFUSED /booru/${parsed.md5}${variant ? ` (${variant})` : ""}: its file is Matrix media ${mxc} ` +
              "and no post this reader may see holds it outside Matrix, so it is served only through the Matrix door (room check). " +
              `Fix: if a booru post that did not come from Matrix should show it, ask posts.json?tags=md5:${parsed.md5}&only=id,source,is_deleted ` +
              `for that post's source and visibility; index/md5/${parsed.md5}.json names the Matrix id.${unreviewed}`,
          );
          d.signals.matrixRefused(`/booru/${parsed.md5} is Matrix media ${mxc}`);
          res.set("Cache-Control", "no-store");
          return res.status(404).json({ error: "not found" });
        }
      }
      if (!ownPost && !(await d.visibility.sees(parsed.md5, viewer))) {
        // The booru says no. A published page's grant is the one other yes
        // (publication-grants.js): only for an md5 a LIVE page shows.
        const pubs = d.pubHashes(req.cookies);
        if (pubs.length > 0 && d.quarantine.check({ md5: parsed.md5, mxc: null }) === "refuse") {
          // Flagged or banished: shown nowhere, a published page included.
          d.signals.quarantineRefused(`/booru/${parsed.md5}`);
          res.set("Cache-Control", "no-store");
          return res.status(404).json({ error: "not found" });
        }
        const granted = pubs.length > 0 && (await d.publications.grants(parsed.md5, pubs));
        if (granted) {
          d.signals.publicationGranted(`/booru/${parsed.md5}`);
        } else {
          d.signals.booruHidden(`/booru/${parsed.md5}`);
          res.set("Cache-Control", "no-store");
          return res.status(404).json({ error: "not found" });
        }
      }
      if (!variant && !(await d.originalExists(d.booruR2Key(parsed.md5, parsed.ext, null)))) {
        return res.status(404).json({ error: "not found" });
      }
    } catch (err) {
      if (err instanceof PublicationsUnavailable) {
        // The publication path only: the booru answered, and said no. Refused
        // until sampling can say which pictures the page shows.
        d.log.error(`[booru-media] SAMPLING UNREACHABLE for a publication grant -- refusing (fail closed): ${err.message}`);
        d.signals.publicationsUnavailable(err.message);
        res.set("Retry-After", "2");
        res.set("Cache-Control", "no-store");
        return res.status(503).json({ error: "media authorization temporarily unavailable" });
      }
      if (err instanceof QuarantineUnavailable) {
        // The publication path only, as above: whether the page's picture is
        // quarantined cannot be told, so it is not granted.
        d.log.error(`[booru-media] QUARANTINE UNREADABLE for a publication grant -- refusing (fail closed): ${err.message}`);
        d.signals.quarantineUnavailable(err.message);
        res.set("Retry-After", "2");
        res.set("Cache-Control", "no-store");
        return res.status(503).json({ error: "media authorization temporarily unavailable" });
      }
      if (err instanceof BooruUnavailable) {
        d.log.error(`[booru-media] BOORU UNREACHABLE -- refusing (fail closed): ${err.message}`);
        d.signals.booruUnavailable(err.message);
        res.set("Retry-After", "2");
        res.set("Cache-Control", "no-store");
        return res.status(503).json({ error: "media authorization temporarily unavailable" });
      }
      d.log.error(`[booru-media] lookup failed: ${err.message}`);
      return res.status(503).json({ error: "media lookup unavailable" });
    }

    try {
      // Nothing is signed for a caller that will not be handed it.
      const signed = edge ? await d.presign(d.booruR2Key(parsed.md5, parsed.ext, variant), disposition) : null;
      return d.sendRelease(req, res, signed, { edge });
    } catch (err) {
      d.log.error(`[booru-media] presign failed: ${err.message}`);
      return res.status(502).json({ error: "could not release media" });
    }
  };
}


// The Matrix id index/md5/<md5>.json names, for a refusal's log line and
// signal. Never fails the request: the answer is already a 404.
async function matrixIdOf(d, md5) {
  if (typeof d.matrixIndexOf !== "function") return "(mxc id not looked up)";
  try {
    const idx = await d.matrixIndexOf(md5);
    return idx && typeof idx.mxc_media_id === "string" ? `mxc ${idx.mxc_media_id}` : "(index/md5 names no mxc id)";
  } catch (err) {
    return `(mxc id unreadable: ${err.message})`;
  }
}

// THE BOORU SESSION EXACTLY AS THE BROWSER SENT IT. cookie-parser hands the
// route a URL-DECODED value, and Rails' encrypted session is base64 that the
// browser carries escaped (%2B, %2F, %3D). Forwarded decoded, its "+" reached
// Rack as a literal "+", which Rack's cookie parsing reads as a space: the
// session would not decrypt, every reader was anonymous to the booru, and Gold
// readers were refused restricted images they may see (2026-10-02, live).
// The raw header is the truth; the re-encode is for a caller that has only the
// parsed jar, and produces the same escaping Rack would.
function booruSessionAsSent(req, name) {
  const header = req.headers && req.headers.cookie;
  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) {
        const v = part.slice(i + 1).trim();
        return v || undefined;
      }
    }
  }
  const parsed = req.cookies && req.cookies[name];
  return typeof parsed === "string" && parsed ? encodeURIComponent(parsed) : undefined;
}

module.exports = { makeBooruHandler };
