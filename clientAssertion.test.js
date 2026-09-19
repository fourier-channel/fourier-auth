"use strict";
// The client assertion.
//
// Every assertion here is verified with a real crypto.verify against the real
// public key, not by inspecting the string. The failure this guards is a JWT
// that LOOKS correct and is rejected by the server with "invalid_client" and
// nothing pointing at why.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const {
  clientAssertion, clientAuthParams, publicJwk, loadSigningKey, algFor,
} = require("./clientAssertion");

const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function parts(jwt) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url")),
    claims: JSON.parse(Buffer.from(p, "base64url")),
    sig: Buffer.from(s, "base64url"),
    signingInput: h + "." + p,
  };
}

test("the alg comes from the key, not from configuration", () => {
  // A declared alg that disagrees with the key is a signature failure at
  // runtime with a misleading error; the key already knows the answer.
  assert.equal(algFor(ec), "ES256");
  assert.equal(algFor(rsa), "RS256");
});

test("an unsupported key names the fix", () => {
  const ed = crypto.generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => algFor(ed), /Fix:/);
});

test("ES256 signs in raw r||s, not DER -- the trap", () => {
  // Node's default ECDSA output is DER-wrapped and variable length. JOSE
  // requires exactly 64 bytes of r||s for P-256. Getting this wrong produces
  // a well-formed JWT that no JOSE verifier accepts.
  const { sig, signingInput } = parts(
    clientAssertion({ key: ec, clientId: "cid", audience: "https://mas/token" }));
  assert.equal(sig.length, 64, "P-256 JOSE signatures are exactly 64 bytes");
  assert.ok(crypto.verify("sha256", Buffer.from(signingInput),
    { key: crypto.createPublicKey(ec), dsaEncoding: "ieee-p1363" }, sig));
});

test("RS256 signs and verifies too", () => {
  const { sig, signingInput, header } = parts(
    clientAssertion({ key: rsa, clientId: "cid", audience: "https://mas/token" }));
  assert.equal(header.alg, "RS256");
  assert.ok(crypto.verify("sha256", Buffer.from(signingInput),
    crypto.createPublicKey(rsa), sig));
});

test("the full RFC 7523 claim set is present even though MAS 1.22 ignores most of it", () => {
  // MAS verifies by signature only: it reads client_id from `sub` and checks
  // nothing else. We send the rest because the RFC requires it and a future
  // MAS that does enforce them must not find us non-compliant.
  const { claims } = parts(clientAssertion({
    key: ec, clientId: "cid", audience: "https://mas/token", now: 1000 }));
  assert.equal(claims.iss, "cid");
  assert.equal(claims.sub, "cid", "MAS reads the client id from sub");
  assert.equal(claims.aud, "https://mas/token");
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp, 1060);
  assert.ok(claims.jti);
});

test("the lifetime is short and the clock is injectable", () => {
  const { claims } = parts(clientAssertion({
    key: ec, clientId: "c", audience: "a", now: 5000, lifetimeSec: 30 }));
  assert.equal(claims.exp - claims.iat, 30);
});

test("every assertion is unique, so nothing is ever reused", () => {
  const a = parts(clientAssertion({ key: ec, clientId: "c", audience: "a", now: 1 }));
  const b = parts(clientAssertion({ key: ec, clientId: "c", audience: "a", now: 1 }));
  assert.notEqual(a.claims.jti, b.claims.jti,
    "same second, different jti -- a cached assertion would be the one way "
    + "this could grow a replay problem of its own making");
});

test("a kid rides in the header, which is what makes a key roll possible", () => {
  const { header } = parts(clientAssertion({
    key: ec, clientId: "c", audience: "a", kid: "k2" }));
  assert.equal(header.kid, "k2");
  // Absent when not given, rather than null or empty.
  assert.equal("kid" in parts(
    clientAssertion({ key: ec, clientId: "c", audience: "a" })).header, false);
});

test("a missing input is refused rather than signed", () => {
  assert.throws(() => clientAssertion({ key: null, clientId: "c", audience: "a" }));
  assert.throws(() => clientAssertion({ key: ec, clientId: "", audience: "a" }));
  assert.throws(() => clientAssertion({ key: ec, clientId: "c", audience: "" }));
});

test("the public JWK is publishable and carries no private material", () => {
  const jwk = publicJwk(ec, "k1");
  assert.equal(jwk.kty, "EC");
  assert.equal(jwk.crv, "P-256");
  assert.equal(jwk.alg, "ES256");
  assert.equal(jwk.use, "sig");
  assert.equal(jwk.kid, "k1");
  // `d` is the private scalar. Its presence would mean the migration shipped
  // the secret to MAS after all, which is the one outcome that would make
  // this whole change pointless.
  assert.equal(jwk.d, undefined, "no private scalar may appear in the public JWK");
  assert.equal(JSON.stringify(jwk).includes('"d"'), false);
});

test("an assertion verifies against the exported JWK, not just the key object", () => {
  // End to end through the format MAS will actually hold.
  const jwt = clientAssertion({ key: ec, clientId: "cid", audience: "https://mas/token" });
  const { sig, signingInput } = parts(jwt);
  const imported = crypto.createPublicKey({ key: publicJwk(ec, "k1"), format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(signingInput),
    { key: imported, dsaEncoding: "ieee-p1363" }, sig));
});

test("clientAuthParams sends the assertion when a key is present", () => {
  const p = clientAuthParams({
    key: ec, clientId: "cid", clientSecret: "shhh", audience: "https://mas/token" });
  assert.equal(p.client_assertion_type,
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  assert.ok(p.client_assertion);
  // The key WINS over a secret that is still configured -- otherwise the
  // migration would silently keep sending the secret after the key landed.
  assert.equal(p.client_secret, undefined);
});

test("clientAuthParams falls back to the secret only when there is no key", () => {
  const p = clientAuthParams({
    key: null, clientId: "cid", clientSecret: "shhh", audience: "a" });
  assert.equal(p.client_secret, "shhh");
  assert.equal(p.client_assertion, undefined);
});

test("with neither credential it throws rather than sending an unauthenticated request", () => {
  // Sending nothing would get a refusal from MAS about something else
  // entirely, and the real cause would not be in the message.
  assert.throws(
    () => clientAuthParams({ key: null, clientId: "cid", clientSecret: "", audience: "a" }),
    /neither OIDC_CLIENT_PRIVATE_KEY nor OIDC_CLIENT_SECRET/);
});

test("loadSigningKey accepts a PEM with escaped newlines, as pasted into a .env", () => {
  const pem = ec.export({ type: "pkcs8", format: "pem" });
  assert.ok(loadSigningKey({ OIDC_CLIENT_PRIVATE_KEY: pem }));
  assert.ok(loadSigningKey({ OIDC_CLIENT_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }));
});

test("loadSigningKey is null when unset, and names the fix when malformed", () => {
  assert.equal(loadSigningKey({}), null);
  assert.throws(() => loadSigningKey({ OIDC_CLIENT_PRIVATE_KEY: "not a key" }),
    /Fix: it must be a PKCS#8 PEM/);
});

test("no secret value appears in any error this module raises", () => {
  // These errors reach logs. A credential must not.
  try {
    loadSigningKey({ OIDC_CLIENT_PRIVATE_KEY: "SUPERSECRETVALUE" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.message.includes("SUPERSECRETVALUE"), false);
  }
});
