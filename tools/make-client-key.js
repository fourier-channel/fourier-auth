#!/usr/bin/env node
"use strict";
// Generate the client signing key, and print the PUBLIC half for MAS.
//
//   node tools/make-client-key.js [kid]
//
// The PRIVATE key goes into the offline secrets source as
// OIDC_CLIENT_PRIVATE_KEY and reaches the container as an env var. The PUBLIC
// JWK goes into MAS's client block. Only one of those two is a secret, which
// is the entire point of the migration.
//
// P-256 by default: MAS advertises ES256, the keys are small enough to paste
// into an env file without wrapping, and signing is faster than RSA at a
// rate that matters when every token refresh does it.
//
// The private key is written to STDERR and the public JWK to STDOUT, so
// `node tools/make-client-key.js > jwk.json` leaves the secret on the
// terminal and never in a file by accident.
const crypto = require("crypto");
const { publicJwk } = require("../clientAssertion");

const kid = process.argv[2] || "fourier-auth-" + crypto.randomBytes(4).toString("hex");
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const pem = privateKey.export({ type: "pkcs8", format: "pem" });
process.stderr.write(
  "\n--- PRIVATE KEY (stderr) -------------------------------------------\n" +
  "Put this in the offline secrets source as OIDC_CLIENT_PRIVATE_KEY.\n" +
  "It must never reach a repo, a log, or MAS.\n\n" + pem + "\n" +
  "kid: " + kid + "  ->  set OIDC_CLIENT_KID to this\n" +
  "--------------------------------------------------------------------\n\n");

process.stdout.write(JSON.stringify({ keys: [publicJwk(privateKey, kid)] }, null, 2) + "\n");
