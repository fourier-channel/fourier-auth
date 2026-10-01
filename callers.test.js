"use strict";

// Who is asking (leak audit F-G2 and F-G5, 2026-10-01).

const test = require("node:test");
const assert = require("node:assert/strict");
const { isEdgeCaller, edgeClientIp, healthDetailAllowed, isPrivateAddress } = require("./callers");

test("F-G2: only the exact secret is the edge; an unset secret makes nobody the edge", () => {
  assert.equal(isEdgeCaller({ "x-fourier-edge": "s3cret" }, "s3cret"), true);
  assert.equal(isEdgeCaller({ "x-fourier-edge": "s3cre" }, "s3cret"), false);
  assert.equal(isEdgeCaller({ "x-fourier-edge": "s3cretX" }, "s3cret"), false);
  assert.equal(isEdgeCaller({}, "s3cret"), false);
  assert.equal(isEdgeCaller({ "x-fourier-edge": "" }, ""), false, "unset is not open");
  assert.equal(isEdgeCaller({ "x-fourier-edge": "anything" }, undefined), false);
  assert.equal(isEdgeCaller({ "x-fourier-edge": ["s3cret", "s3cret"] }, "s3cret"), false, "a repeated header is not a string");
});

test("F-G2: the client address is believed only from the edge", () => {
  const h = { "x-fourier-edge": "k", "x-fourier-client-ip": "203.0.113.9" };
  assert.equal(edgeClientIp(h, "k"), "203.0.113.9");
  assert.equal(edgeClientIp(h, "other"), null);
  assert.equal(edgeClientIp({ "x-fourier-edge": "k", "x-fourier-client-ip": "1.2.3.4\r\nX: y" }, "k"), null);
  assert.equal(edgeClientIp({ "x-fourier-edge": "k", "x-fourier-client-ip": "2001:db8::1" }, "k"), "2001:db8::1");
});

test("F-G5: /healthz detail only for a local or tailnet caller that came through no proxy", () => {
  // A curl on the box, into the published 127.0.0.1 port: the docker gateway.
  assert.equal(healthDetailAllowed("172.18.0.1", {}), true);
  assert.equal(healthDetailAllowed("::ffff:127.0.0.1", {}), true);
  assert.equal(healthDetailAllowed("100.91.63.22", {}), true, "tailnet");
  // The public, through Caddy (or the booru's nginx): same private socket, but
  // a forwarding header.
  assert.equal(healthDetailAllowed("172.18.0.1", { "x-forwarded-for": "198.51.100.7" }), false);
  assert.equal(healthDetailAllowed("172.18.0.1", { "cf-connecting-ip": "198.51.100.7" }), false);
  assert.equal(healthDetailAllowed("172.18.0.1", { via: "1.1 Caddy" }), false);
  // Anything not private.
  assert.equal(healthDetailAllowed("198.51.100.7", {}), false);
  assert.equal(healthDetailAllowed(undefined, {}), false);
});

test("private ranges are exactly the private ranges", () => {
  for (const a of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "::1"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "8.8.8.8", "192.169.0.1", "fe80::1", "not-an-ip"]) {
    assert.equal(isPrivateAddress(a), false, a);
  }
});
