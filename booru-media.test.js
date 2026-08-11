"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseBooruFile, pickVariant, booruR2Key } = require("./booru-media");

// These guard a string that becomes an R2 object key. The interesting cases are
// the rejections: this route is reachable by anyone who can reach the gate, and
// the booru is not the only possible caller.

test("parses a well-formed md5 filename", () => {
  const p = parseBooruFile("f2b68ef0122f71f9dfda5d2251d3e4c8.png");
  assert.deepStrictEqual(p, { md5: "f2b68ef0122f71f9dfda5d2251d3e4c8", ext: ".png" });
});

test("rejects anything that is not 32 lowercase hex plus a known extension", () => {
  for (const bad of [
    "",
    "not-an-md5.png",
    "F2B68EF0122F71F9DFDA5D2251D3E4C8.png",      // uppercase
    "f2b68ef0122f71f9dfda5d2251d3e4c.png",       // 31 chars
    "f2b68ef0122f71f9dfda5d2251d3e4c88.png",     // 33 chars
    "f2b68ef0122f71f9dfda5d2251d3e4c8.exe",      // not an allowed extension
    "f2b68ef0122f71f9dfda5d2251d3e4c8",          // no extension
    "../../etc/passwd",
    "f2b68ef0122f71f9dfda5d2251d3e4c8.png/../../secret",
  ]) {
    assert.strictEqual(parseBooruFile(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("no parsed value can escape its prefix", () => {
  // Belt and braces: even if parsing were loosened, the key must stay inside
  // media/ or variants/.
  const p = parseBooruFile("f2b68ef0122f71f9dfda5d2251d3e4c8.jpg");
  const key = booruR2Key(p.md5, p.ext, null);
  assert.ok(key.startsWith("media/"));
  assert.ok(!key.includes(".."));
});

test("no size means the original", () => {
  assert.strictEqual(pickVariant({}), null);
  assert.strictEqual(pickVariant(undefined), null);
  assert.strictEqual(
    booruR2Key("f2b68ef0122f71f9dfda5d2251d3e4c8", ".png", null),
    "media/f2b68ef0122f71f9dfda5d2251d3e4c8.png",
  );
});

test("sizes snap to renditions we actually hold", () => {
  assert.strictEqual(pickVariant({ w: "180" }), "180x180");
  assert.strictEqual(pickVariant({ w: "360" }), "360x360");
  assert.strictEqual(pickVariant({ w: "720" }), "720x720");
  assert.strictEqual(pickVariant({ w: "850" }), "sample");
  // 320 is in the Synapse thumbnail list but is NOT a booru variant. It must
  // snap to one we rendered rather than 404 an image that exists.
  assert.strictEqual(pickVariant({ w: "320" }), "360x360");
  // Absurd values still land somewhere real.
  assert.strictEqual(pickVariant({ w: "5" }), "180x180");
  assert.strictEqual(pickVariant({ w: "99999" }), "sample");
  assert.strictEqual(pickVariant({ w: "garbage" }), "360x360"); // parseInt NaN -> 360 default
});

test("a variant key is derived, and never lands in the media/ namespace", () => {
  // reconcile-r2 lists media/ to count OBJECTS. A rendition appearing there
  // would inflate that count with things that are not objects.
  const key = booruR2Key("f2b68ef0122f71f9dfda5d2251d3e4c8", ".png", "360x360");
  assert.strictEqual(key, "variants/f2b68ef0122f71f9dfda5d2251d3e4c8/360x360.jpg");
  assert.ok(!key.startsWith("media/"));
});

test("h is honoured as well as w", () => {
  assert.strictEqual(pickVariant({ h: "720" }), "720x720");
});
