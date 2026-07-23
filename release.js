"use strict";

// Decide how to release an already-authorized local original to the caller:
//
//   "redirect" -> a 302 straight to the presigned R2 URL. Native browser loads
//     (an <img src>, a link navigation, a download) follow redirects
//     transparently and are NOT subject to the fetch() Origin-null CORS taint,
//     so plain <img>/<a> consumers (chanbooru) work with no client-side
//     envelope resolution at all.
//
//   "json" -> the { url } envelope. fetch()/XHR callers (Technetium's
//     fetchMediaSrc) resolve it client-side and assign the URL to an <img src>.
//
// SAFETY INVARIANT: never redirect a cors request. A fetch() that follows a
// cross-origin 302 gets its request Origin tainted to "null", which R2's CORS
// allow-list cannot match -> the load is blocked despite a 200. Technetium's
// original path is exactly such a cors fetch, so it MUST keep the JSON envelope.
//
// Absent Sec-Fetch-* headers (older browsers, curl, non-browser clients) fall
// through to "json": the pre-existing, safe default -- behavior only changes for
// requests a browser explicitly labels as an image/navigation load.
function originalRelease(headers) {
  const dest = (headers && headers["sec-fetch-dest"]) || "";
  const mode = (headers && headers["sec-fetch-mode"]) || "";
  const nativeLoad =
    dest === "image" ||
    dest === "document" ||
    dest === "iframe" ||
    mode === "navigate";
  return nativeLoad && mode !== "cors" ? "redirect" : "json";
}

module.exports = { originalRelease };
