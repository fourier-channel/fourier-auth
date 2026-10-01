"use strict";

// WHO IS ASKING -- the two questions the gate asks of a request before it
// decides what to put in the answer, as opposed to whether to say yes.
//
// 1. IS THIS THE EDGE? (leak audit F-G2, 2026-10-01)
//
// The gate is publicly reachable at mxc.41chan.net, because that is where the
// Cloudflare Worker asks it. Anyone else could ask it too, and got back what
// the Worker gets: {"url": <presigned R2 URL>} or a 302 to one. That URL names
// the R2 account id, the bucket and the access key id (X-Amz-Credential), is a
// bearer credential for its lifetime, and is a way around the Worker -- whose
// own header says the presigned URL is never exposed to readers. It was, to
// anyone who called the gate directly.
//
// So a presigned URL is released only to a caller that proves it is the
// Worker, by a shared secret in the X-Fourier-Edge header: MEDIA_EDGE_SECRET,
// set in the gate's environment and as a Worker secret (wrangler secret put),
// committed nowhere. Every other caller gets the DECISION and no URL -- the same
// yes or no, so the coherence access matrix can still measure the gate from
// outside, and no credential and no byte.
//
// Unset MEDIA_EDGE_SECRET is NOT "open": nobody is the edge, every picture
// fails, and boot and /healthz say why. A gate that hands credentials to the
// world because a variable was forgotten is the failure this closes.
//
// 2. MAY THIS CALLER READ THE LAMP'S DETAIL? (F-G5)
//
// /healthz's "last:" strings carry mxc ids and Matrix user ids. Public callers
// get levels and counts; a caller on this machine or the tailnet that came
// through no proxy gets the detail. "Came through no proxy" matters more than
// the address: Caddy and the booru's nginx both reach this container from a
// private docker address, so every public request LOOKS local by its socket.
// What they also do is add X-Forwarded-For, which a direct curl does not.

const crypto = require("crypto");

const EDGE_HEADER = "x-fourier-edge";
// The reader's address, as Cloudflare saw it, forwarded by the Worker. Trusted
// ONLY alongside a valid edge secret; from anyone else it is a string.
const CLIENT_IP_HEADER = "x-fourier-client-ip";

function digest(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

/** True when the request carries the edge secret. False when no secret is set. */
function isEdgeCaller(headers, secret) {
  if (!secret) return false;
  const got = headers && headers[EDGE_HEADER];
  if (typeof got !== "string" || got.length === 0) return false;
  // Compare digests: equal length always, so timingSafeEqual never throws and
  // the comparison says nothing about how much of a guess was right.
  return crypto.timingSafeEqual(digest(got), digest(secret));
}

/** The reader's IP the Worker vouched for, or null. */
function edgeClientIp(headers, secret) {
  if (!isEdgeCaller(headers, secret)) return null;
  const ip = headers[CLIENT_IP_HEADER];
  return typeof ip === "string" && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "via", "cf-connecting-ip", "x-real-ip"];

function isPrivateAddress(addr) {
  if (typeof addr !== "string" || !addr) return false;
  let a = addr.toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return o1 === 127 || o1 === 10
    || (o1 === 172 && o2 >= 16 && o2 <= 31)
    || (o1 === 192 && o2 === 168)
    || (o1 === 100 && o2 >= 64 && o2 <= 127); // tailnet, 100.64.0.0/10
}

/** May this caller see /healthz detail (mxc ids, MXIDs)? */
function healthDetailAllowed(remoteAddress, headers) {
  if (!isPrivateAddress(remoteAddress)) return false;
  for (const h of PROXY_HEADERS) if (headers && headers[h] !== undefined) return false;
  return true;
}

module.exports = { isEdgeCaller, edgeClientIp, healthDetailAllowed, isPrivateAddress, EDGE_HEADER, CLIENT_IP_HEADER };
