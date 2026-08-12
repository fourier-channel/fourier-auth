"use strict";

// Key derivation for booru-native media: the objects fourier-sampling puts in
// R2 for a booru that holds no media of its own.
//
// Pure functions, extracted from the route for the same reason release.js and
// verify.js are: the parts worth testing are the parsing and the key shape, and
// neither should need an HTTP server or a live bucket to exercise.

// Rendered by fourier-sampling at upload time. Sizes are chanbooru's
// FOURIER_VARIANT_SIZES. Deliberately NOT ALLOWED_THUMB_SIZES, which is the set
// Synapse will resize on demand and includes 320 -- snapping to a size nobody
// rendered would 404 a picture that exists.
// name AND extension, because they are not uniform: danbooru renders 720x720 as
// webp (quality 75) and the rest as jpeg (85), per MediaAsset#convert_file.
// fourier-sampling matches that exactly so both writers agree on one object per
// (md5, variant). Assuming .jpg here would ask R2 for a key nobody wrote.
// Only the renditions danbooru ALWAYS produces. Its variant_types are
// 180x180/360x360/720x720 unconditionally, plus `sample` ONLY when the image is
// wider than LARGE_IMAGE_WIDTH, plus `full` only for webp/avif. Snapping a
// request to `sample` would therefore 404 on every small image -- fine while
// fourier-sampling rendered its own sample for everything, and wrong the moment
// danbooru became the only producer (2026-08-12).
//
// This is the flexible surface adapting to the strict one: danbooru's set is
// fixed by its own UI, the gate takes any ?w= and snaps, so the gate is what
// bends. 850 now lands on 720x720, which is a slightly smaller picture and
// always exists -- better than a correct size that is sometimes absent.
const BOORU_VARIANT_SIZES = Object.freeze({
  180: { name: "180x180", ext: ".jpg" },
  360: { name: "360x360", ext: ".jpg" },
  720: { name: "720x720", ext: ".webp" },
});

// What 4chan actually serves, plus webp. The list is an allowlist rather than a
// pattern because this string becomes part of an object key.
const BOORU_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".webm", ".mp4"]);

/**
 * Parse "<md5>.<ext>" into its parts, or null when it is not one.
 *
 * Strict by construction: 32 lowercase hex, then an extension from the
 * allowlist. A caller cannot walk out of the prefix, request another tenant's
 * object, or smuggle a query string through the key.
 */
function parseBooruFile(file) {
  const m = /^([0-9a-f]{32})(\.[a-z0-9]{1,5})$/.exec(String(file || ""));
  if (!m) return null;
  const [, md5, ext] = m;
  if (!BOORU_EXTS.has(ext)) return null;
  return { md5, ext };
}

/**
 * Which rendered variant a ?w=/?h= request means, or null for the original.
 *
 * Snapped to the sizes we hold rather than honoured literally, so a caller
 * cannot ask for an arbitrary size and get a 404 for something that exists at
 * the next size up.
 */
function pickVariant(query) {
  const raw = (query && (query.w || query.h)) || null;
  if (!raw) return null;
  const want = parseInt(raw, 10) || 360;
  const sizes = Object.keys(BOORU_VARIANT_SIZES).map(Number);
  const nearest = sizes.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  return BOORU_VARIANT_SIZES[nearest];
}

/**
 * The R2 key for an object or one of its renditions.
 *
 * Three prefixes, three meanings, and they are kept apart on purpose:
 * `media/` is the object (and the only thing reconcile-r2 counts), `variants/`
 * is derived and regenerable, `thumbs/` is 4chan's own small copy.
 */
function booruR2Key(md5, ext, variant) {
  return variant ? `variants/${md5}/${variant.name}${variant.ext}` : `media/${md5}${ext}`;
}

module.exports = { BOORU_VARIANT_SIZES, BOORU_EXTS, parseBooruFile, pickVariant, booruR2Key };
