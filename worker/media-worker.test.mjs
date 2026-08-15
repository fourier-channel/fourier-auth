import test from "node:test";
import assert from "node:assert";
import { parseMediaPath, authUrl, resolveUpstream, responseHeaders } from "./media-worker.mjs";

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
  assert.equal(h.get("Content-Disposition"), "attachment");
  // Nothing from R2 is forwarded blind.
  assert.equal(h.get("location"), null);
  assert.equal(h.get("x-amz-request-id"), null);
});

test("thumbnails render inline, originals download", () => {
  const up = new Headers({ "content-type": "image/png" });
  assert.equal(responseHeaders(up, "thumbnail").get("Content-Disposition"), "inline");
  assert.equal(responseHeaders(up, "download").get("Content-Disposition"), "attachment");
});
