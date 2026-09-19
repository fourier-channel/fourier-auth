"use strict";
// Proving who we are to MAS WITHOUT sending a shared secret.
//
// Until now fourier-auth authenticated with client_secret_post: the secret
// travels in the body of every token request, which means it is held by two
// parties, crosses the wire on every login and every refresh, is visible to
// whatever terminates TLS, and has to be rotated in two places at once.
//
// private_key_jwt (RFC 7523) replaces that with proof of possession. We sign
// a short assertion with a private key MAS has never seen; MAS verifies it
// against our PUBLIC key. The credential never leaves this container, and
// MAS's side of the rotation is a public key -- which is not a secret at all.
//
// NO NEW DEPENDENCY. There is no JWT library in this project and there does
// not need to be: node:crypto signs and exports JWKs on its own. Proven on
// the actual deployed runtime (node v22.23.2 inside the running container)
// rather than assumed from the docs.
//
// ES256 HAS ONE TRAP. Node's default ECDSA output is DER-wrapped, and JOSE
// requires the raw r||s form. Without dsaEncoding: "ieee-p1363" every
// assertion is a well-formed JWT with a signature no JOSE verifier accepts,
// and the failure arrives as a flat "invalid_client" from MAS with nothing
// pointing at the encoding.
//
// WHAT THIS DOES NOT BUY US. MAS 1.22.0 verifies the assertion by SIGNATURE
// ONLY -- it reads client_id from `sub` and checks the signature against the
// client's JWKS, and does not enforce aud, exp, iat or jti. So a captured
// assertion is replayable as far as that server is concerned. We send the
// full RFC 7523 claim set anyway, because the claims cost nothing, they are
// what the RFC requires, and a future MAS that does check them must not find
// us non-compliant. But the honest statement of the gain is "the secret no
// longer travels", not "requests cannot be replayed".
const crypto = require("crypto");

/** base64url with no padding, as JOSE requires. */
function b64u(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Which JOSE alg a key can sign with. Derived from the key ITSELF rather than
// configured, because a mismatch between a declared alg and the actual key is
// a runtime signature failure with a misleading error, and the key already
// knows the answer.
function algFor(key) {
  const t = key.asymmetricKeyType;
  if (t === "ec") {
    const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
    if (curve === "prime256v1") return "ES256";
    if (curve === "secp384r1") return "ES384";
    const e = new Error(
      `unsupported EC curve ${curve || "(unknown)"} for a client assertion. ` +
      "Fix: generate a P-256 key (prime256v1), which MAS advertises as ES256.");
    throw e;
  }
  if (t === "rsa") return "RS256";
  const e = new Error(
    `unsupported key type ${t || "(unknown)"} for a client assertion. ` +
    "Fix: use an EC P-256 key or an RSA key; MAS advertises ES256, RS256 and PS256.");
  throw e;
}

/**
 * Load the signing key from the environment.
 *
 * A PEM in an env var rather than a path, so it lands the same way every
 * other secret in this container does and no volume mount has to be added.
 * Newlines survive docker-compose fine; a literal "\n" form is also accepted
 * because that is how a key pasted into a .env usually arrives, and the
 * failure otherwise is an opaque "error:0909006C" from OpenSSL.
 */
function loadSigningKey(env = process.env) {
  const pem = env.OIDC_CLIENT_PRIVATE_KEY;
  if (!pem) return null;
  const normalised = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  try {
    return crypto.createPrivateKey(normalised);
  } catch (err) {
    const e = new Error(
      `OIDC_CLIENT_PRIVATE_KEY is set but is not a usable private key (${err.message}). ` +
      "Fix: it must be a PKCS#8 PEM -- generate one with tools/make-client-key.js.");
    throw e;
  }
}

/**
 * Build one signed client assertion.
 *
 * @param {object} o
 * @param {crypto.KeyObject} o.key   the private key
 * @param {string} o.clientId        iss and sub, per RFC 7523
 * @param {string} o.audience        the token endpoint (or the issuer)
 * @param {number} [o.lifetimeSec]   how long it is valid. Short on purpose.
 * @param {number} [o.now]           seconds since epoch; injectable for tests
 * @param {string} [o.kid]           key id, so MAS can pick from a JWKS with
 *                                   more than one key -- which is what makes
 *                                   a zero-downtime key roll possible
 */
function clientAssertion({ key, clientId, audience, lifetimeSec = 60, now, kid }) {
  if (!key) throw new Error("clientAssertion: no signing key");
  if (!clientId) throw new Error("clientAssertion: no clientId");
  if (!audience) throw new Error("clientAssertion: no audience");
  const alg = algFor(key);
  const iat = Math.floor(now === undefined ? Date.now() / 1000 : now);
  const header = { alg, typ: "JWT" };
  if (kid) header.kid = kid;
  const claims = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    // Unique per assertion. MAS 1.22.0 does not check it, but a jti is what
    // any server that DOES enforce single-use will key on, and generating it
    // costs nothing.
    jti: b64u(crypto.randomBytes(16)),
    iat,
    exp: iat + lifetimeSec,
  };
  const signingInput =
    b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(claims));
  const opts = { key };
  // The trap. Without this Node emits DER and no JOSE verifier accepts it.
  if (alg.startsWith("ES")) opts.dsaEncoding = "ieee-p1363";
  const digest = alg.endsWith("384") ? "sha384" : "sha256";
  const sig = crypto.sign(digest, Buffer.from(signingInput), opts);
  return signingInput + "." + b64u(sig);
}

/**
 * The PUBLIC half, as a JWK for MAS's client config.
 *
 * This is the whole point of the migration: what MAS stores stops being a
 * secret. A leaked public key is a non-event.
 */
function publicJwk(key, kid) {
  const pub = crypto.createPublicKey(key);
  const jwk = pub.export({ format: "jwk" });
  jwk.use = "sig";
  jwk.alg = algFor(key);
  if (kid) jwk.kid = kid;
  return jwk;
}

/**
 * The client-authentication parameters for a token request.
 *
 * DUAL MODE, and that is deliberate for the migration rather than
 * permanently: with a key configured it returns the assertion, with only a
 * secret it returns the secret, and with neither it throws rather than
 * silently sending an unauthenticated request that MAS would refuse with a
 * message about something else. The secret branch is deleted once the key is
 * live on both sides -- see DEVLOG.
 */
function clientAuthParams({ key, clientId, clientSecret, audience, kid, now }) {
  if (key) {
    return {
      client_id: clientId,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion({ key, clientId, audience, kid, now }),
    };
  }
  if (clientSecret) {
    return { client_id: clientId, client_secret: clientSecret };
  }
  throw new Error(
    "no client credential: neither OIDC_CLIENT_PRIVATE_KEY nor " +
    "OIDC_CLIENT_SECRET is set. Fix: set one; the private key is preferred " +
    "and never leaves this container.");
}

module.exports = { clientAssertion, clientAuthParams, publicJwk, loadSigningKey, algFor, b64u };
