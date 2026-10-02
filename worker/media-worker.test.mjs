import test from "node:test";
import assert from "node:assert";
import worker, { saveOptions, extensionFor, parseBooruPath, parseMediaPath, authUrl, resolveUpstream, responseHeaders, deny, corsHeaders, refusesAnonymous, denialStatus, decisionTtl, booruCookie, MAX_PUB_COOKIES } from "./media-worker.mjs";

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
  // fourier-auth's own answers are passed through -- 404 (no such image, or
  // withheld) and 503 (being prepared) included; anything else is our failure,
  // not the reader's, and says 502.
  for (const s of [401, 403, 404, 503]) assert.equal(denialStatus(s), s);
  for (const s of [500, 502, 504, undefined, 0]) assert.equal(denialStatus(s), 502, String(s));
});

test("a download with a trailing filename goes through the gate, never straight to Synapse", () => {
  assert.deepEqual(parseMediaPath("/_matrix/client/v1/media/download/41chan.net/abc/photo.png"),
    { kind: "download", serverName: "41chan.net", mediaId: "abc" });
  assert.equal(parseMediaPath("/_matrix/client/v1/media/thumbnail/41chan.net/abc/extra"), null, "a thumbnail has no filename");
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

test("the room hint is forwarded for both kinds, never invented", () => {
  const q = new URLSearchParams("width=320&room_id=%21abc%3A41chan.net")
  const t = new URL(authUrl("https://mxc", { serverName: "41chan.net", mediaId: "m", kind: "thumbnail" }, q))
  assert.equal(t.searchParams.get("room_id"), "!abc:41chan.net")
  // An original carries no size but still needs the hint: encrypted media is
  // encrypted whether you are asking for a thumbnail or the full image.
  const d = new URL(authUrl("https://mxc", { serverName: "41chan.net", mediaId: "m", kind: "download" }, q))
  assert.equal(d.searchParams.get("room_id"), "!abc:41chan.net")
  // Absent stays absent.
  const n = new URL(authUrl("https://mxc", { serverName: "41chan.net", mediaId: "m", kind: "download" }, new URLSearchParams()))
  assert.equal(n.searchParams.get("room_id"), null)
});

test("recognises exactly the booru original path chanbooru links", () => {
  assert.deepEqual(parseBooruPath("/fourier/booru/142f98626259e188a9e044b8b1d5cdd7.jpg"),
    { kind: "booru", file: "142f98626259e188a9e044b8b1d5cdd7.jpg" });
  assert.equal(parseBooruPath("/fourier/booru/142f98626259e188a9e044b8b1d5cdd7.jpg/../x"), null);
  assert.equal(parseBooruPath("/fourier/booru/notamd5.jpg"), null);
  assert.equal(parseBooruPath("/fourier/login"), null);
  assert.equal(parseBooruPath("/fourier/booru/"), null);
  assert.equal(parseBooruPath("/_matrix/client/v1/media/download/41chan.net/abc"), null);
});

test("asks the booru gate with the variant size and never forwards dl", () => {
  const p = parseBooruPath("/fourier/booru/142f98626259e188a9e044b8b1d5cdd7.jpg");
  assert.equal(authUrl("https://mxc.41chan.net/", p, new URLSearchParams("w=360&h=360&dl=1")),
    "https://mxc.41chan.net/booru/142f98626259e188a9e044b8b1d5cdd7.jpg?w=360&h=360");
  assert.equal(authUrl("https://mxc.41chan.net", p, new URLSearchParams("")),
    "https://mxc.41chan.net/booru/142f98626259e188a9e044b8b1d5cdd7.jpg");
});

test("dl=1 hands the client an attachment named by the file; otherwise inline for images", () => {
  const up = new Headers({ "content-type": "image/jpeg", "content-length": "10" });
  assert.equal(responseHeaders(up, "booru").get("Content-Disposition"), "inline");
  assert.equal(responseHeaders(up, "booru", { saveAs: "142f98626259e188a9e044b8b1d5cdd7.jpg" }).get("Content-Disposition"),
    'attachment; filename="142f98626259e188a9e044b8b1d5cdd7.jpg"');
  assert.equal(responseHeaders(up, "booru", { saveAs: 'a"b.jpg' }).get("Content-Disposition"), 'attachment; filename="ab.jpg"');
});

test("dl=1 on a Matrix download saves as <mediaId>.<ext from type>; thumbnails never save", () => {
  const dl = new URLSearchParams("dl=1");
  assert.deepEqual(saveOptions(parseMediaPath("/_matrix/client/v1/media/download/41chan.net/abcDEF"), dl), { saveAs: "abcDEF", extFromType: true });
  assert.deepEqual(saveOptions(parseMediaPath("/_matrix/client/v1/media/thumbnail/41chan.net/abcDEF"), dl), {});
  assert.deepEqual(saveOptions(parseBooruPath("/fourier/booru/142f98626259e188a9e044b8b1d5cdd7.jpg"), dl), { saveAs: "142f98626259e188a9e044b8b1d5cdd7.jpg" });
  assert.deepEqual(saveOptions(parseMediaPath("/_matrix/client/v1/media/download/41chan.net/abcDEF"), new URLSearchParams("")), {});
  const up = new Headers({ "content-type": "image/png" });
  assert.equal(responseHeaders(up, "download", { saveAs: "abcDEF", extFromType: true }).get("Content-Disposition"), 'attachment; filename="abcDEF.png"');
  assert.equal(extensionFor("image/jpeg"), ".jpg");
  assert.equal(extensionFor("application/octet-stream"), "");
});

test("a listed origin gets credentialed CORS echoed; anyone else keeps the wildcard", () => {
  const list = ["https://booru.41chan.net", "https://tc.41chan.net"];
  const echoed = corsHeaders("https://booru.41chan.net", list);
  assert.equal(echoed["Access-Control-Allow-Origin"], "https://booru.41chan.net");
  assert.equal(echoed["Access-Control-Allow-Credentials"], "true");
  assert.equal(echoed["Vary"], "Origin");
  assert.equal(corsHeaders("https://evil.example", list)["Access-Control-Allow-Origin"], "*");
  assert.equal(corsHeaders("https://evil.example", list)["Access-Control-Allow-Credentials"], undefined);
  assert.equal(corsHeaders(null, list)["Access-Control-Allow-Origin"], "*");
  assert.equal(corsHeaders()["Access-Control-Allow-Origin"], "*");
  const up = new Headers({ "content-type": "image/png" });
  assert.equal(responseHeaders(up, "download", { origin: "https://tc.41chan.net", credentialedOrigins: list }).get("Access-Control-Allow-Credentials"), "true");
  assert.equal(responseHeaders(up, "download", {}).get("Access-Control-Allow-Origin"), "*");
  assert.equal(deny(403, "M_FORBIDDEN", "no", corsHeaders("https://booru.41chan.net", list)).headers.get("Access-Control-Allow-Origin"), "https://booru.41chan.net");
});

test("a request with no credential is refused for Matrix media and asked of the gate for booru media", async () => {
  // The published thread is read with no session at all, and the booru's post
  // visibility is the gate for imageboard media (2026-09-18). Refusing before
  // asking made the same picture 200 at the origin and 401 at the edge.
  assert.equal(refusesAnonymous(parseMediaPath("/_matrix/client/v1/media/thumbnail/m.example/abc")), true);
  assert.equal(refusesAnonymous(parseMediaPath("/_matrix/client/v1/media/download/m.example/abc")), true);
  assert.equal(refusesAnonymous(parseBooruPath("/fourier/booru/" + "a".repeat(32) + ".jpg")), false);
  // And the gate is asked with NO credential header invented for it.
  let seen = null;
  const fake = async (_u, init) => { seen = init.headers; return { status: 200, json: async () => ({ url: "https://r2/x" }) }; };
  const d = await resolveUpstream(fake, "u", { authorization: null, cookie: null });
  assert.equal(d.ok, true);
  assert.equal(seen.Authorization, undefined);
  assert.equal(seen.Cookie, undefined);
  // A gate that still wants a session says so, and that answer passes through.
  const refusing = async () => ({ status: 401, json: async () => ({}) });
  assert.deepEqual(await resolveUpstream(refusing, "u", { authorization: null, cookie: null }), { ok: false, status: 401 });
});


// -- leak audit 2026-10-01 ---------------------------------------------------

test("F-G2: the gate is asked WITH the edge secret and the reader's address", async () => {
  let seen = null;
  const fake = async (url, init) => { seen = init.headers; return { status: 200, json: async () => ({ url: "https://r2/x?sig" }) }; };
  const r = await resolveUpstream(fake, "https://mxc/booru/x.png", { cookie: "a=b" }, { secret: "k", clientIp: "203.0.113.9" });
  assert.equal(r.ok, true);
  assert.equal(seen["X-Fourier-Edge"], "k");
  assert.equal(seen["X-Fourier-Client-IP"], "203.0.113.9");
  // No secret, no address either: the address is only believed alongside it.
  await resolveUpstream(fake, "u", { cookie: "a=b" }, { clientIp: "203.0.113.9" });
  assert.equal(seen["X-Fourier-Edge"], undefined);
  assert.equal(seen["X-Fourier-Client-IP"], undefined);
});

test("F-G2: a gate that withholds the URL from this Worker is a 502, named as withheld", async () => {
  const fake = async () => ({ status: 200, json: async () => ({ allowed: true, released: false, error: "x" }) });
  assert.deepEqual(await resolveUpstream(fake, "u", { cookie: "a=b" }, { secret: "wrong" }), { ok: false, status: 502, withheld: true });
});

test("F-G1: a booru allow lives 60 s at the edge, a Matrix allow 240 s", () => {
  assert.equal(decisionTtl("booru"), 60);
  assert.equal(decisionTtl("download"), 240);
  assert.equal(decisionTtl("thumbnail"), 240);
});

// The whole fetch handler, with Cloudflare's globals faked: what the GATE is
// sent (secret on, client-supplied edge headers never copied), and that a
// booru allow is cached for 60 s.
test("F-G1/F-G2 end to end: the Worker sends its own secret, never the client's, and caches a booru allow 60 s", async () => {
  const puts = [];
  const gateCalls = [];
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => store.get(typeof req === "string" ? req : req.url) || undefined,
    put: async (req, res) => { puts.push({ url: req.url, cc: res.headers.get("Cache-Control") }); },
  } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://mxc.example/")) {
      gateCalls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ url: "https://r2.example/media/" + "a".repeat(32) + ".png?X-Amz-Signature=s" }), { status: 200 });
    }
    return new Response("PNGBYTES", { status: 200, headers: { "Content-Type": "image/png" } });
  };
  try {
    const req = new Request("https://booru.41chan.net/fourier/booru/" + "a".repeat(32) + ".png", {
      headers: { Cookie: "_danbooru2_session=s", "CF-Connecting-IP": "203.0.113.9", "X-Fourier-Edge": "client-forged", "X-Fourier-Client-IP": "6.6.6.6" },
    });
    const waits = [];
    const res = await worker.fetch(req, { FOURIER_AUTH_BASE: "https://mxc.example", MEDIA_EDGE_SECRET: "real-secret" }, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PNGBYTES");
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0].headers["X-Fourier-Edge"], "real-secret");
    assert.equal(gateCalls[0].headers["X-Fourier-Client-IP"], "203.0.113.9");
    const decision = puts.find((p) => p.url.startsWith("https://authz.fourier.internal/"));
    assert.equal(decision.cc, "max-age=60");
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.caches;
  }
});

// -- a published page's grant (operator ruling 2026-10-02) -------------------

const PH = (c) => c.repeat(32);

test("PUB: booru media forwards the session, the booru session and well-formed grants -- nothing else", () => {
  const raw = `cf_clearance=zzz; fourier_session=fs; _danbooru2_session=ds; fourier_pub_${PH("a")}=1; fourier_pub_NOTHEX=1; fourier_pub_${PH("A")}=1; theme=dark`;
  assert.equal(booruCookie(raw, null), `fourier_session=fs; _danbooru2_session=ds; fourier_pub_${PH("a")}=1`);
  assert.equal(booruCookie("theme=dark; cf_clearance=z", null), null);
  assert.equal(booruCookie(null, null), null);
});

test("PUB: at most 8 grants, and the page the picture was requested from is never the one dropped", () => {
  const hs = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(32, "0"));
  const raw = hs.map((h) => `fourier_pub_${h}=1`).join("; ");
  assert.equal(MAX_PUB_COOKIES, 8);
  const plain = booruCookie(raw, null).split("; ");
  assert.equal(plain.length, 8);
  const fromPage = booruCookie(raw, `https://booru.41chan.net/sample/p/${hs[11]}`).split("; ");
  assert.equal(fromPage.length, 8);
  assert.equal(fromPage[0], `fourier_pub_${hs[11]}=1`, "the Referer's publication goes first");
});

test("PUB end to end: grants reach the gate, and two readers' different grants are two cache keys", async () => {
  const puts = [];
  const gateCalls = [];
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => store.get(typeof req === "string" ? req : req.url),
    put: async (req, res) => { puts.push(req.url); store.set(req.url, new Response(await res.clone().text(), res)); },
  } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://mxc.example/")) {
      gateCalls.push(init.headers.Cookie || null);
      return new Response(JSON.stringify({ url: "https://r2.example/variants/" + "c".repeat(32) + "/360x360.jpg?X-Amz-Signature=s" }), { status: 200 });
    }
    return new Response("JPEG", { status: 200, headers: { "Content-Type": "image/jpeg" } });
  };
  try {
    const env = { FOURIER_AUTH_BASE: "https://mxc.example", MEDIA_EDGE_SECRET: "k" };
    const ask = async (cookie) => {
      const waits = [];
      const req = new Request("https://booru.41chan.net/fourier/booru/" + "c".repeat(32) + ".jpg?w=360", { headers: { Cookie: cookie } });
      const r = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      return r.status;
    };
    assert.equal(await ask(`theme=dark; fourier_pub_${PH("a")}=1`), 200);
    assert.equal(gateCalls[0], `fourier_pub_${PH("a")}=1`, "the grant reached the gate; the rest did not");
    // Same reader again: the cached allow serves it.
    assert.equal(await ask(`theme=light; fourier_pub_${PH("a")}=1`), 200);
    assert.equal(gateCalls.length, 1, "a cookie the gate never reads does not split the cache");
    // A different reader, holding no grant: their own question, never the first reader's answer.
    await ask("theme=dark");
    assert.equal(gateCalls.length, 2);
    assert.equal(gateCalls[1], null);
    await ask(`fourier_pub_${PH("b")}=1`);
    assert.equal(gateCalls.length, 3, "another page's grant is another key");
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.caches;
  }
});
