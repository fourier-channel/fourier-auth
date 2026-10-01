"use strict";

// GET /booru/:file -- booru-native media, as a handler with its dependencies
// injected, so the rules that decide who gets which bytes are tested without
// Redis, R2 or a booru (booru-route.test.js).
//
// ONE FILE, TWO DOORS, and this is the booru's. The order of the questions:
//
//   1. Is it a Matrix image's one file? Refused: those are served only through
//      the Matrix door, which asks the room (canon.js puts DM images in media/
//      too, under their md5).
//   2. Does a post exist for this md5 that THIS REQUESTER may see? Asked of the
//      booru (booru-visibility.js). No -> 404, the same answer as "no such
//      object", so the gate does not confirm that a hidden image exists.
//      Original AND variants: a thumbnail of a jailed image is the jailed image.
//   3. For an original: is it still in the bucket? (moved to superseded/ -> 404)
//   4. Release: the presigned URL to the edge Worker only; everyone else gets
//      the decision without it (release.js sendRelease, callers.js).
//
// The booru being unreachable is a 503 with Retry-After, logged loudly and
// counted on the lamp: fail CLOSED. Serving bytes because the authority could
// not be asked is the leak this route was rewritten to close.

const { BooruUnavailable } = require("./booru-visibility");

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
    const booruSession = req.cookies && req.cookies[d.booruCookieName];
    const viewer = booruSession ? { sessionCookie: booruSession, clientIp: d.clientIp(req.headers) } : null;

    try {
      if (await d.isMatrixImage(parsed.md5)) return res.status(404).json({ error: "not found" });
      if (!(await d.visibility.sees(parsed.md5, viewer))) {
        d.signals.booruHidden(`/booru/${parsed.md5}`);
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "not found" });
      }
      if (!variant && !(await d.originalExists(d.booruR2Key(parsed.md5, parsed.ext, null)))) {
        return res.status(404).json({ error: "not found" });
      }
    } catch (err) {
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

module.exports = { makeBooruHandler };
