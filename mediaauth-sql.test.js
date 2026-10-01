"use strict";

// The leak audit's F-G3 and F-G4 (2026-10-01), against a REAL Postgres: the
// SQL that applies the uploader rule, run on a miniature of Synapse's schema.
// mediaauth-core.test.js proves the decision around these queries with fakes;
// this proves the queries themselves say what that decision assumes.
//
// NEEDS A DATABASE, so it is SKIPPED -- and says so -- unless
// MEDIAAUTH_TEST_PG names one (a postgres:// URL; a throwaway container is
// enough). It creates its own schema and drops it after.
//
//   docker run -d --rm --name fa-sqltest -e POSTGRES_PASSWORD=t -p 127.0.0.1:55432:5432 postgres:16
//   MEDIAAUTH_TEST_PG=postgres://postgres:t@127.0.0.1:55432/postgres node --test mediaauth-sql.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeQueries } = require("./mediaauth-sql");

const URL_ = process.env.MEDIAAUTH_TEST_PG;
const skip = URL_ ? false : "MEDIAAUTH_TEST_PG is not set -- the SQL of the uploader rule is NOT exercised in this run";

const HS = "41chan.net";
const V = "@victim:41chan.net", A = "@attacker:41chan.net", F = "@friend:41chan.net", L = "@legacy:41chan.net";
const mxc = (id) => `mxc://${HS}/${id}`;

let client, q, schema;

test.before(async () => {
  if (skip) return;
  const { Client } = require("pg");
  client = new Client({ connectionString: URL_ });
  await client.connect();
  schema = "fa_sqltest_" + process.pid;
  await client.query(`create schema ${schema}; set search_path to ${schema}`);
  await client.query(`
    create table events (event_id text primary key, room_id text, type text, sender text, state_key text);
    create table event_json (event_id text primary key, room_id text, json text);
    create table profiles (user_id text, displayname text, avatar_url text, full_user_id text);
    create table local_media_repository (media_id text unique, user_id text);
    create table room_memberships (event_id text, user_id text, sender text, room_id text, membership text);
    create table current_state_events (event_id text, room_id text, type text, state_key text);
  `);
  let n = 0;
  const ev = async (room, type, sender, content) => {
    const id = `$e${++n}`;
    await client.query("insert into events values ($1,$2,$3,$4,null)", [id, room, type, sender]);
    await client.query("insert into event_json values ($1,$2,$3)", [id, room, JSON.stringify({ type, sender, content })]);
  };
  const join = (user, room) => client.query("insert into room_memberships values ($1,$2,$2,$3,'join')", [`$m${++n}`, user, room]);
  const media = (id, user) => client.query("insert into local_media_repository values ($1,$2)", [id, user]);

  // The victim's DM with a friend. dm1 is the victim's upload, posted there.
  await join(V, "!dm"); await join(F, "!dm");
  await media("dm1", V);
  await ev("!dm", "m.room.message", V, { msgtype: "m.image", url: mxc("dm1") });
  // The friend forwards it (by reference, as Element does) into their room.
  await join(F, "!friends");
  await ev("!friends", "m.room.message", F, { msgtype: "m.image", url: mxc("dm1") });
  // The attacker, never in the DM, learned the mxc and uses it every way there is.
  await join(A, "!lair");
  await client.query("insert into profiles values ('attacker', 'a', $1, $2)", [mxc("dm1"), A]);
  await ev("!lair", "m.room.member", A, { membership: "join", avatar_url: mxc("dm1") });
  await ev("!lair", "m.room.avatar", A, { url: mxc("dm1") });
  await ev("!lair", "m.room.message", A, { msgtype: "m.image", url: mxc("dm1") });
  await ev("!lair", "im.ponies.room_emotes", A, { images: { stolen: { url: mxc("dm1") } } });

  // Real site assets, each set by its own uploader.
  await media("av1", V); await media("ra1", V); await media("em1", V);
  await client.query("insert into profiles values ('victim', 'v', $1, $2)", [mxc("av1"), V]);
  await join(V, "!shared"); await join(A, "!shared");
  await ev("!shared", "m.room.member", V, { membership: "join", avatar_url: mxc("av1") });
  await ev("!shared", "m.room.avatar", V, { url: mxc("ra1") });
  await ev("!shared", "im.ponies.room_emotes", V, { images: { wave: { url: mxc("em1") } } });
  // A profile row from before full_user_id existed.
  await media("lg1", L);
  await client.query("insert into profiles values ('legacy', 'l', $1, null)", [mxc("lg1")]);
  // Media with no upload record (older than the record, or remote): old rule.
  await client.query("insert into profiles values ('attacker2', 'a', $1, '@attacker2:41chan.net')", [mxc("norecord")]);

  // Encrypted rooms: the victim was in !enc2, never in !enc.
  await join(V, "!enc2"); await join(A, "!enc2"); await join(A, "!enc");
  await client.query("insert into current_state_events values ('$s1','!enc','m.room.encryption','')");

  q = makeQueries(client, { homeserverName: HS });
});

test.after(async () => {
  if (skip || !client) return;
  await client.query(`drop schema ${schema} cascade`);
  await client.end();
});

test("uploader: a local media id's uploader; null for remote and unknown ids", { skip }, async () => {
  assert.equal(await q.queryUploader(HS, "dm1"), V);
  assert.equal(await q.queryUploader("matrix.org", "dm1"), null);
  assert.equal(await q.queryUploader(HS, "nope"), null);
});

test("F-G3: a DM image set as the attacker's avatar, room icon or emote is NOT a site asset", { skip }, async () => {
  assert.equal(await q.queryIsSiteAsset(mxc("dm1"), V, HS), false);
  // The pre-fix rule (uploader unknown) is what made it one -- the hole, reproduced.
  assert.equal(await q.queryIsSiteAsset(mxc("dm1"), null, HS), true);
});

test("F-G3: real avatars, room icons and emotes stay site assets", { skip }, async () => {
  assert.equal(await q.queryIsSiteAsset(mxc("av1"), V, HS), true, "profile avatar");
  assert.equal(await q.queryIsSiteAsset(mxc("ra1"), V, HS), true, "room avatar");
  assert.equal(await q.queryIsSiteAsset(mxc("em1"), V, HS), true, "emote");
  assert.equal(await q.queryIsSiteAsset(mxc("lg1"), L, HS), true, "a profile row with no full_user_id");
  assert.equal(await q.queryIsSiteAsset(mxc("norecord"), null, HS), true, "no upload record: old rule");
});

test("F-G3: a DM image is in the DM and a friend's forward -- never in the attacker's room", { skip }, async () => {
  const rooms = (await q.queryMediaRooms(mxc("dm1"), V)).sort();
  assert.deepEqual(rooms, ["!dm", "!friends"]);
  // The pre-fix rule: every way the attacker referenced it put it in !lair.
  assert.ok((await q.queryMediaRooms(mxc("dm1"), null)).includes("!lair"));
});

test("F-G3: a real member avatar is still placed in the rooms its owner set it in", { skip }, async () => {
  assert.deepEqual(await q.queryMediaRooms(mxc("av1"), V), ["!shared"]);
});

test("F-G4: the uploader has been in the hinted room, or has not", { skip }, async () => {
  assert.equal(await q.queryUploaderJoined("!enc2", V), true);
  assert.equal(await q.queryUploaderJoined("!enc", V), false);
  assert.equal(await q.queryIsEncrypted("!enc"), true);
});

test("the queries run as written against the indexes the gate declares", { skip }, async () => {
  // The four expression indexes, built here as the deploy builds them, so a
  // query that no longer matches their expressions would still run -- this
  // does not prove the planner uses them (tiny tables never would); it proves
  // the declared SQL and the queries agree on table and column names.
  const fs = require("node:fs");
  const sql = fs.readFileSync(require.resolve("./db/synapse-indexes.sql"), "utf8")
    .replace(/^--.*$/gm, "").replace(/CONCURRENTLY /g, "")
    .split(";").map((s) => s.trim()).filter((s) => /^(CREATE|ANALYZE)/.test(s));
  assert.ok(sql.length >= 4, "the index file parsed");
  for (const stmt of sql) await client.query(stmt);
  assert.equal(await q.queryIsSiteAsset(mxc("av1"), V, HS), true);
});
