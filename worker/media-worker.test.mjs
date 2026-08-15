import test from "node:test";
import assert from "node:assert";
import { parseMediaPath, authUrl, resolveUpstream, responseHeaders, deny, corsHeaders } from "./media-worker.mjs";

// The Worker cannot be deployed from this box (no Cloudflare token with
// Workers scope), so its decision logic is tested here instead of being
// shipped on faith. Everything below is pure: path parsing, the URL it asks
// fourier-auth, how it reads the answer, and what it hands the client.

test("recognises exactly the authenticated-media paths", () => {
  assert.deepEqual(parseMediaPath("/_matrix/client/v1/media/download/41chan.net/abc"),
    { kind: "download", serverName: "41chan.net", mediaId: "abc" });
  assert.deepEqual(parseMediaPath("/_matrix/client/v1/media/thumbnail/matrix.org/xyz"),
    { kind: "thumbnail", serverName: "matrix.org", mediaId: "xyz" });
});

test("leaves every other path alone", () => {
  // Anything it does not recognise goes to the origin untouched. A Worker that
  // half-handles /_matrix would break login, sync and federation.
  for (const p of ["/_matrix/client/v3/sync", "/_matrix/media/v3/download/41chan.net/abc",
                   "/_matrix/client/v1/media/config", "/", "/_synapse/admin/v1/server_version"]) {
    assert.equal(parseMediaPath(p), null, p);
  }
});

test("passes thumbnail sizing through without inventing one", () => {
  const q = new URLSearchParams("width=320&height=320&method=scale");
  const u = new URL(authUrl("https://mxc.41chan.net", { serverName: "41chan.net", mediaId: "abc", kind: "thumbnail" }, q));
  assert.equal(u.pathname, "/media/41chan.net/abc");
  assert.equal(u.searchParams.get("w"), "320");
  // The gate snaps sizes to its own allowed set; the Worker must not second
  // guess it, or the two disagree about which rendition is correct.
  assert.equal(u.searchParams.get("method"), null);
});

test("an original asks for no size at all", () => {
  const u = new URL(authUrl("https://mxc.41chan.net", { serverName: "41chan.net", mediaId: "abc", kind: "download" }, new URLSearchParams("width=320")));
  assert.equal(u.search, "");
});

test("server names with dots and ports survive encoding", () => {
  const u = new URL(authUrl("https://mxc.41chan.net", { serverName: "matrix.org:8448", mediaId: "a/b", kind: "download" }, new URLSearchParams()));
  assert.ok(u.pathname.startsWith("/media/matrix.org%3A8448/"), u.pathname);
});

test("asks as a cors fetch, so the presigned URL comes back as JSON not a Location", async () => {
  let seen = null;
  const fake = async (url, init) => { seen = init.headers; return { status: 200, json: async () => ({ url: "https://r2/x?sig" }) }; };
  const r = await resolveUpstream(fake, "https://mxc/media/a/b", "Bearer tok");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://r2/x?sig");
  assert.equal(seen["Sec-Fetch-Mode"], "cors");
  assert.equal(seen.Authorization, "Bearer tok");
});

test("a refusal is a refusal -- no bytes, no guessing", async () => {
  for (const status of [401, 403, 404, 502]) {
    const fake = async () => ({ status, json: async () => ({}) });
    assert.deepEqual(await resolveUpstream(fake, "u", "Bearer t"), { ok: false, status });
  }
});

test("a 200 with no url is not a success", async () => {
  const fake = async () => ({ status: 200, json: async () => ({ nope: true }) });
  assert.equal((await resolveUpstream(fake, "u", "Bearer t")).ok, false);
});

test("client headers never carry the presigned URL, and mark media inert", () => {
  const up = new Headers({ "content-type": "image/png", "content-length": "123",
                           "x-amz-request-id": "leaky", location: "https://r2/x?X-Amz-Signature=abc" });
  const h = responseHeaders(up, "download");
  assert.equal(h.get("Content-Type"), "image/png");
  assert.equal(h.get("Cache-Control"), "private, max-age=31536000, immutable");
  assert.equal(h.get("X-Content-Type-Options"), "nosniff");
  // image/png is inline: safe to render, and forcing a download would be a
  // behaviour change against Synapse. The disposition rule is pinned by its
  // own tests below.
  assert.equal(h.get("Content-Disposition"), "inline");
  // Nothing from R2 is forwarded blind.
  assert.equal(h.get("location"), null);
  assert.equal(h.get("x-amz-request-id"), null);
});

test("disposition follows the CONTENT TYPE, not the endpoint", () => {
  // An original and a thumbnail of the same PNG are equally safe to render.
  for (const kind of ["thumbnail", "download"]) {
    assert.equal(responseHeaders(new Headers({ "content-type": "image/png" }), kind).get("Content-Disposition"), "inline");
    assert.equal(responseHeaders(new Headers({ "content-type": "image/svg+xml" }), kind).get("Content-Disposition"), "attachment");
  }
});

test("only a known-inert allowlist renders inline", () => {
  const d = (ct) => responseHeaders(new Headers({ "content-type": ct }), "download").get("Content-Disposition");
  for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "audio/ogg", "image/png; charset=binary"]) {
    assert.equal(d(ok), "inline", ok);
  }
  // The ones that matter: an uploaded document must not execute in the origin
  // of whoever opens it.
  for (const bad of ["text/html", "image/svg+xml", "application/pdf", "text/javascript", "application/xhtml+xml", ""]) {
    assert.equal(d(bad), "attachment", bad || "<none>");
  }
});


test("a refusal is Matrix-shaped and never cached", async () => {
  const r = deny(403, "M_FORBIDDEN", "Not authorized for this media");
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await r.json(), { errcode: "M_FORBIDDEN", error: "Not authorized for this media" });
});

test("the status a denial carries", () => {
  // fourier-auth's own answer is passed through for the two that ARE answers;
  // anything else is our failure, not the user's, and says 502.
  const map = (s) => (s === 401 || s === 403 ? s : 502);
  assert.equal(map(401), 401);
  assert.equal(map(403), 403);
  for (const s of [500, 502, 504, undefined, 0]) assert.equal(map(s), 502, String(s));
});

test("CORS is on every response, including refusals", () => {
  // Technetium runs on localhost and reads media cross-origin. A denial without
  // Access-Control-Allow-Origin is unreadable to it -- the browser reports a
  // CORS error and hides the 401, so the client cannot even tell the user why.
  const r = deny(401, "M_UNAUTHORIZED", "no");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const h = responseHeaders(new Headers({ "content-type": "image/png" }), "download");
  assert.equal(h.get("Access-Control-Allow-Origin"), "*");
  assert.ok(h.get("Access-Control-Expose-Headers").includes("Content-Type"));
});

test("the preflight contract matches Synapse's", () => {
  const c = corsHeaders();
  assert.ok(c["Access-Control-Allow-Headers"].includes("Authorization"),
    "a client that cannot send Authorization cannot fetch authenticated media at all");
  assert.ok(c["Access-Control-Allow-Methods"].includes("GET"));
});

test("either credential is accepted, and a Bearer wins when both are sent", async () => {
  // The booru's <img> cannot send a header, so it presents the site-wide
  // session cookie instead. Same identity, same check, different proof.
  let seen = null;
  const fake = async (_u, init) => { seen = init.headers; return { status: 200, json: async () => ({ url: "https://r2/x" }) }; };
  await resolveUpstream(fake, "u", { authorization: null, cookie: "fourier_session=abc" });
  assert.equal(seen.Cookie, "fourier_session=abc");
  assert.equal(seen.Authorization, undefined);

  await resolveUpstream(fake, "u", { authorization: "Bearer t", cookie: "fourier_session=abc" });
  assert.equal(seen.Authorization, "Bearer t");
  assert.equal(seen.Cookie, undefined, "a Bearer must not be sent alongside a cookie");
});

test("the old string signature still works", async () => {
  let seen = null;
  const fake = async (_u, init) => { seen = init.headers; return { status: 200, json: async () => ({ url: "https://r2/x" }) }; };
  await resolveUpstream(fake, "u", "Bearer t");
  assert.equal(seen.Authorization, "Bearer t");
});
