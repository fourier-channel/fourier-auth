"use strict";

// The operator's board door (operator ruling 2026-10-25): pass, the two 403s,
// missing and malformed config, and the gate wired into /verify by name.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperatorGate, parseOperatorGateConfig } = require("./operator-gate");

const SABER = "@saber:41chan.net";
const quiet = { error: () => {} };
const gate = (env = { OPERATOR_GATE_MXIDS: SABER }) =>
  createOperatorGate({ config: parseOperatorGateConfig(env), log: quiet });

test("pass: the listed account -> 204 with its identity and no-store", async () => {
  const r = await gate().answer(SABER);
  assert.equal(r.status, 204);
  assert.equal(r.headers["X-Fourier-Identity"], SABER);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.body, undefined);
});

test("not signed in -> 403 naming where to sign in, with no identity", async () => {
  const r = await gate().answer(null);
  assert.equal(r.status, 403);
  assert.equal(r.headers["X-Fourier-Identity"], undefined);
  assert.match(r.body, /signed in to 41chan/);
  assert.match(r.body, /booru\.41chan\.net/);
});

test("anyone else, including a near miss -> 403 naming who they are, never who is listed", async () => {
  for (const who of ["@maple:41chan.net", "@saber:41chan.net.evil", "@SABER:41chan.net", "@saber:41chan.ne"]) {
    const r = await gate().answer(who);
    assert.equal(r.status, 403, who);
    assert.equal(r.headers["X-Fourier-Identity"], undefined, who);
    assert.ok(r.body.includes("signed in as"), who);
  }
  const r = await gate().answer("@maple:41chan.net");
  assert.ok(!r.body.includes(SABER), "the refusal does not name the listed account");
});

test("an identity is escaped in the refusal page", async () => {
  const r = await gate().answer("@<script>:x");
  assert.equal(r.status, 403);
  assert.ok(!r.body.includes("<script>"));
});

test("missing or malformed config fails closed for everyone, with its remedy", async () => {
  for (const env of [{}, { OPERATOR_GATE_MXIDS: "" }, { OPERATOR_GATE_MXIDS: " , " },
    { OPERATOR_GATE_MXIDS: "saber" }, { OPERATOR_GATE_MXIDS: `${SABER},@bad` }]) {
    const cfg = parseOperatorGateConfig(env);
    assert.equal(cfg.ok, false, JSON.stringify(env));
    assert.match(cfg.problem, /docker-compose\.yaml/);
    const r = await createOperatorGate({ config: cfg, log: quiet }).answer(SABER);
    assert.equal(r.status, 503, JSON.stringify(env));
    assert.equal(r.headers["X-Fourier-Identity"], undefined);
  }
});

test("a list of two, spaces trimmed", async () => {
  const g = gate({ OPERATOR_GATE_MXIDS: ` ${SABER} , @op2:41chan.net ` });
  assert.equal((await g.answer("@op2:41chan.net")).status, 204);
  assert.equal((await g.answer(SABER)).status, 204);
});
