"use strict";

// The leak audit's F-G3 and F-G4 (2026-10-01), against a REAL Postgres: the
// SQL that applies the uploader rule, run on a miniature of Synapse's schema.
// Since 2026-10-15 also gate 3 for posts (fourier-basis GATE3_CONTRACTS.md):
// a viewer's joined rooms, the redaction rule, the reader's touch page and
// its plan, and the placements reader end to end on this database.
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
const skip = URL_ ? false : "MEDIAAUTH_TEST_PG is not set -- the SQL of the uploader rule, the sampling gate and gate 3 (rooms, redactions, the placements reader) is NOT exercised in this run";

const HS = "41chan.net";
const V = "@victim:41chan.net", A = "@attacker:41chan.net", F = "@friend:41chan.net", L = "@legacy:41chan.net";
const mxc = (id) => `mxc://${HS}/${id}`;

let client, q, schema, ev, tpImage;

// One Synapse event: events + event_json, the next stream ordering unless one
// is given, contains_url computed the way Synapse's _store_event_txn does
// ("url" in content and a string). Returns the event id.
let n = 0;
let nextOrdering = 100;
function makeEv(c) {
  return async (room, type, sender, content, { ordering, top = {} } = {}) => {
    const id = `$e${++n}`;
    const so = ordering === undefined ? nextOrdering++ : ordering;
    const containsUrl = !!content && typeof content.url === "string";
    await c.query(
      "insert into events (event_id, room_id, type, sender, state_key, stream_ordering, contains_url, received_ts) values ($1,$2,$3,$4,null,$5,$6,$7)",
      [id, room, type, sender, so, containsUrl, 1792026850000 + so]);
    await c.query("insert into event_json values ($1,$2,$3)", [id, room, JSON.stringify({ type, sender, content, ...top })]);
    return id;
  };
}
// A redaction as Synapse stores one: the m.room.redaction event (redacts in
// content from room v11, at the top level before it) and its redactions row.
async function redact(c, room, sender, target, { v11 = true, ordering } = {}) {
  const id = await ev(room, "m.room.redaction", sender, v11 ? { redacts: target } : {}, { ordering, top: v11 ? {} : { redacts: target } });
  await c.query("insert into redactions (event_id, redacts, received_ts) values ($1,$2,0)", [id, target]);
  return id;
}

test.before(async () => {
  if (skip) return;
  const { Client } = require("pg");
  client = new Client({ connectionString: URL_ });
  await client.connect();
  schema = "fa_sqltest_" + process.pid;
  await client.query(`create schema ${schema}; set search_path to ${schema}`);
  // Synapse's columns and indexes where a query here depends on them (Synapse
  // 1.152.1 full_schemas/72 and later deltas): stream_ordering (unique;
  // backfilled events are negative), contains_url, received_ts, redactions
  // with redactions_redacts, and current_state_events_member_index.
  await client.query(`
    create table events (event_id text primary key, room_id text, type text, sender text, state_key text,
                         stream_ordering bigint not null, contains_url boolean, received_ts bigint);
    create unique index events_stream_ordering on events (stream_ordering);
    create table event_json (event_id text primary key, room_id text, json text);
    create table profiles (user_id text, displayname text, avatar_url text, full_user_id text);
    create table local_media_repository (media_id text unique, user_id text);
    create table room_memberships (event_id text, user_id text, sender text, room_id text, membership text);
    create table current_state_events (event_id text, room_id text, type text, state_key text, membership text);
    create index current_state_events_member_index on current_state_events (state_key) where type = 'm.room.member';
    create table redactions (event_id text not null unique, redacts text not null, have_censored boolean not null default false,
                             received_ts bigint, recheck boolean not null default false);
    create index redactions_redacts on redactions (redacts);
  `);
  ev = makeEv(client);
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

  // The sampling gate's room (ruling 2026-10-09): current state names the
  // live power levels; an OLDER power-levels event (in events, not current)
  // must never be the one read. @left left with a level still recorded.
  const state = async (room, type, key, content, membership = null) => {
    const id = `$cs${++n}`;
    await client.query("insert into event_json values ($1,$2,$3)", [id, room, JSON.stringify({ type, state_key: key, content })]);
    await client.query("insert into current_state_events values ($1,$2,$3,$4,$5)", [id, room, type, key, membership]);
  };
  await client.query("insert into event_json values ('$oldpl','!mods',$1)",
    [JSON.stringify({ type: "m.room.power_levels", content: { users: { [A]: 100 } } })]);
  await state("!mods", "m.room.power_levels", "", { users: { [V]: 100, [F]: 70, "@left:41chan.net": 90 }, users_default: 0 });
  await state("!mods", "m.room.name", "", { name: "modsmodsmods" });
  await state("!mods", "m.room.member", V, { membership: "join" }, "join");
  await state("!mods", "m.room.member", F, { membership: "join" }, "join");
  await state("!mods", "m.room.member", "@left:41chan.net", { membership: "leave" }, "leave");
  await state("!mods", "m.room.member", A, { membership: "invite" }, "invite");

  // -- gate 3 for posts (fourier-basis GATE3_CONTRACTS.md A1, A2) ------------
  // A viewer's rooms are CURRENT state. @left's join to !old is still in
  // room_memberships (history); current state says leave. The attacker has
  // joins in room_memberships everywhere and no current join at all.
  await join("@left:41chan.net", "!old");
  await state("!old", "m.room.member", "@left:41chan.net", { membership: "leave" }, "leave");
  await state("!zeta", "m.room.member", V, { membership: "join" }, "join");
  await state("!Alpha", "m.room.member", V, { membership: "join" }, "join");
  await state("!old", "m.room.member", V, { membership: "join" }, "join");

  // Redactions (operator ruling 2026-10-15: deleting a message hides its image
  // at once). rd1: posted by its uploader in !r1 and !r2; the !r2 post deleted.
  await media("rd1", V); await join(V, "!r1"); await join(V, "!r2");
  await ev("!r1", "m.room.message", V, { msgtype: "m.image", url: mxc("rd1") });
  await redact(client, "!r2", V, await ev("!r2", "m.room.message", V, { msgtype: "m.image", url: mxc("rd1") }));
  // rd2: the uploader's only post, in !rx, forwarded by a member of !rx into
  // !ry -- then the uploader deletes it (pre-v11 form: redacts at the top).
  await media("rd2", V); await join(V, "!rx"); await join(F, "!rx"); await join(F, "!ry");
  const rd2post = await ev("!rx", "m.room.message", V, { msgtype: "m.image", url: mxc("rd2") });
  await ev("!ry", "m.room.message", F, { msgtype: "m.image", url: mxc("rd2") });
  await redact(client, "!rx", V, rd2post, { v11: false });
  // rd3, rd4: a room icon and a member avatar set by their uploader, redacted.
  await media("rd3", V); await media("rd4", V);
  await redact(client, "!shared", V, await ev("!shared", "m.room.avatar", V, { url: mxc("rd3") }));
  await redact(client, "!shared", V, await ev("!shared", "m.room.member", V, { membership: "join", avatar_url: mxc("rd4") }));
  // rd5: an emote pack image, the pack set by the image's uploader, redacted.
  // Each of queryIsSiteAsset's three event arms has its own anti-join, so each
  // needs its own redacted case (review 2026-10-15: removing the emote arm's
  // alone passed every test until this one).
  await media("rd5", V);
  await redact(client, "!shared", V, await ev("!shared", "im.ponies.room_emotes", V, { images: { gone: { url: mxc("rd5") } } }));

  // The touch page's own events, at fixed orderings above everything else.
  await media("tp1", V); await media("tp2", V); await media("bf1", V);
  await ev("!tp", "m.room.message", V, { msgtype: "m.text", body: "no image here" }, { ordering: 5001 });
  tpImage = await ev("!tp", "m.room.message", V, { msgtype: "m.image", url: mxc("tp1") }, { ordering: 5002 });
  await ev("!tp", "m.sticker", V, { body: "s", url: mxc("tp2") }, { ordering: 5003 });
  await ev("!tp", "m.room.member", V, { membership: "join", avatar_url: mxc("tp2") }, { ordering: 5004 });
  await ev("!tp", "m.room.avatar", V, { url: mxc("tp2") }, { ordering: 5005 });
  await redact(client, "!tp", V, tpImage, { ordering: 5006 });
  await redact(client, "!tp", V, tpImage, { ordering: 5007, v11: false });
  // Backfilled: Synapse gives it a NEGATIVE ordering.
  await ev("!tp", "m.room.message", V, { msgtype: "m.image", url: mxc("bf1") }, { ordering: -7 });

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

// -- gate 3 for posts: A1, a viewer's rooms ----------------------------------

test("gate 3 rooms: joined rooms are CURRENT state -- a left room is excluded though history remembers the join", { skip }, async () => {
  assert.deepEqual(await q.queryJoinedRoomsOf("@left:41chan.net"), [], "left !mods and !old; room_memberships still says join in !old");
  assert.deepEqual([...(await q.queryJoinedRoomsOf(V))].sort(), ["!Alpha", "!mods", "!old", "!zeta"]);
  assert.deepEqual(await q.queryJoinedRoomsOf(A), [], "joins in room_memberships, an invite in current state: no rooms");
  assert.deepEqual(await q.queryJoinedRoomsOf("@nobody:41chan.net"), []);
});

// -- gate 3 for posts: redactions (ruled 2026-10-15) ---------------------------

test("gate 3 redactions: a deleted post stops placing its image at once, in that room only", { skip }, async () => {
  assert.deepEqual(await q.queryMediaRooms(mxc("rd1"), V), ["!r1"]);
});

test("gate 3 redactions: a forward stops counting when the uploader's post that vouched for it is deleted", { skip }, async () => {
  assert.deepEqual(await q.queryMediaRooms(mxc("rd2"), V), []);
  // dm1's forward still stands: its uploader's post in !dm was never deleted.
  assert.deepEqual((await q.queryMediaRooms(mxc("dm1"), V)).sort(), ["!dm", "!friends"]);
});

test("gate 3 redactions: a redacted room icon, member avatar or emote pack is no site asset and no placement", { skip }, async () => {
  assert.equal(await q.queryIsSiteAsset(mxc("rd3"), V, HS), false, "room icon");
  assert.equal(await q.queryIsSiteAsset(mxc("rd4"), V, HS), false, "member avatar");
  assert.equal(await q.queryIsSiteAsset(mxc("rd5"), V, HS), false, "emote pack");
  assert.equal(await q.queryIsSiteAsset(mxc("em1"), V, HS), true, "an unredacted emote pack still is one");
  assert.deepEqual(await q.queryMediaRooms(mxc("rd3"), V), []);
  assert.deepEqual(await q.queryMediaRooms(mxc("rd4"), V), []);
  assert.equal(await q.queryIsSiteAsset(mxc("ra1"), V, HS), true, "an unredacted room icon still is one");
});

// -- gate 3 for posts: A2, the reader's queries --------------------------------

test("gate 3 touch page: (from, to] in stream order; image messages, stickers, room avatars and redactions only", { skip }, async () => {
  const page = await q.queryTouchPage(5000, 5007, 100);
  assert.deepEqual(page.map((r) => [r.stream_ordering, r.type]), [
    [5002, "m.room.message"], [5003, "m.sticker"], [5005, "m.room.avatar"], [5006, "m.room.redaction"], [5007, "m.room.redaction"],
  ], "no text message (5001), no member event (5004)");
  assert.equal(page[0].url, mxc("tp1"));
  assert.equal(page[0].room_id, "!tp");
  assert.equal(page[0].sender, V);
  assert.equal(page[3].redacts, tpImage, "room v11: content.redacts");
  assert.equal(page[4].redacts, tpImage, "before v11: top-level redacts");
  assert.equal(page[3].url, null);
  assert.equal(typeof page[0].stream_ordering, "number");
  assert.deepEqual((await q.queryTouchPage(5002, 5005, 100)).map((r) => r.stream_ordering), [5003, 5005], "from exclusive, to inclusive");
  assert.deepEqual((await q.queryTouchPage(5000, 5007, 2)).map((r) => r.stream_ordering), [5002, 5003], "the row limit");
  assert.deepEqual((await q.queryTouchPage(-10, -1, 10)).map((r) => [r.stream_ordering, r.url]), [[-7, mxc("bf1")]], "backfill is negative");
});

test("gate 3 reader queries: bounds, an event by ordering, redaction targets, uploaders, the oldest unread arrival", { skip }, async () => {
  const b = await q.queryStreamBounds();
  assert.equal(b.tail, -7);
  assert.ok(b.head >= 5007);
  assert.ok(Number.isSafeInteger(b.at) && b.at > 1.7e12);
  assert.deepEqual(await q.queryEventAt(5002), { event_id: tpImage, type: "m.room.message" });
  assert.deepEqual((await q.queryEventAt(5006)).type, "m.room.redaction");
  assert.equal(await q.queryEventAt(4999), null);
  const t = await q.queryRedactionTargets([tpImage, "$nope"]);
  assert.equal(t.get(tpImage), mxc("tp1"));
  assert.equal(t.has("$nope"), false);
  const u = await q.queryUploaders(["tp1", "dm1", "unknown"]);
  assert.equal(u.get("tp1"), V);
  assert.equal(u.get("dm1"), V);
  assert.equal(u.has("unknown"), false);
  assert.equal(await q.queryFirstReceivedAfter(5001), 1792026850000 + 5002);
});

// -- gate 3 for posts: the reader end to end, on this database ----------------

const { createPlacementsReader, snapshotRunner, readerPool } = require("./placements-reader");
const quietLog = { log: () => {}, error: () => {} };

function readerOn(cursor) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: URL_, max: 2, options: `-c search_path=${schema}` });
  const pushes = [];
  const reader = createPlacementsReader({
    withSnapshot: snapshotRunner(pool, { homeserverName: HS }),
    booru: {
      getCursor: async () => cursor,
      push: async (body) => { pushes.push(body.placements); return { cursor, applied: body.placements.mxcs.length, stale: 0 }; },
    },
    homeserverName: HS,
    log: quietLog,
  });
  return { reader, pushes, pool };
}

// The pool's bounds are options to node-postgres, and a misspelt one is
// ignored without a word -- so ask Postgres what the session actually got.
test("gate 3 reader pool: its five-second statement timeout and its name reach Postgres; two connections", { skip }, async () => {
  const u = new URL(URL_);
  const pool = readerPool({
    SYNAPSE_DB_HOST: u.hostname, SYNAPSE_DB_PORT: u.port || "5432", SYNAPSE_DB_NAME: u.pathname.slice(1),
    SYNAPSE_DB_USER: decodeURIComponent(u.username), SYNAPSE_DB_PASSWORD: decodeURIComponent(u.password),
  }, { log: quietLog });
  try {
    assert.equal((await pool.query("show statement_timeout")).rows[0].statement_timeout, "5s");
    assert.equal((await pool.query("show application_name")).rows[0].application_name, "fourier-auth-gate3-reader");
    assert.equal(pool.options.max, 2);
  } finally { await pool.end(); }
});

test("gate 3 reader: every pushed answer equals the image gate's own queries -- uploader, forward-by-joined, forward-by-stranger, site asset, redaction", { skip }, async () => {
  const { reader, pushes, pool } = readerOn({ live: 0, sweep: null, lap_started_at: null });
  try {
    await reader.step();
  } finally { await pool.end(); }
  const live = pushes.filter((p) => p.stream === "live");
  assert.ok(live.length >= 1, "a live page was pushed");
  const byMxc = new Map();
  for (const p of live) for (const m of p.mxcs) byMxc.set(m.mxc, m);
  // Each answer, against the queries the image gate itself asks.
  for (const m of byMxc.values()) {
    const mediaId = m.mxc.split("/").pop();
    assert.equal(m.uploader, await q.queryUploader(HS, mediaId), m.mxc);
    assert.equal(m.site_asset, await q.queryIsSiteAsset(m.mxc, m.uploader, HS), m.mxc);
    assert.deepEqual(m.rooms, (await q.queryMediaRooms(m.mxc, m.uploader)).sort(), m.mxc);
  }
  // And the cases by name: the uploader's post and a joined member's forward
  // count, the stranger's post in !lair does not.
  assert.deepEqual(byMxc.get(mxc("dm1")).rooms, ["!dm", "!friends"]);
  assert.equal(byMxc.get(mxc("dm1")).site_asset, false);
  assert.equal(byMxc.get(mxc("ra1")).site_asset, true, "a room icon set by its uploader");
  assert.deepEqual(byMxc.get(mxc("rd1")).rooms, ["!r1"], "the deleted post's room is gone");
  assert.deepEqual(byMxc.get(mxc("tp1")).rooms, [], "redacted twice, placed nowhere");
  assert.equal(byMxc.get(mxc("tp1")).newest_ordering, 5007, "touched last by the redaction at 5007");
  assert.equal(byMxc.has(mxc("bf1")), false, "a negative ordering is the sweep's, not the live cursor's");
  const sweep = pushes.filter((p) => p.stream === "sweep");
  assert.ok(sweep.some((p) => p.mxcs.some((m) => m.mxc === mxc("bf1"))), "the sweep's first lap reads the backfill");
  assert.equal(sweep[0].from, -8, "the sweep starts below the tail");
  for (const p of pushes) {
    assert.ok(Number.isSafeInteger(p.snapshot.head) && Number.isSafeInteger(p.snapshot.at));
    assert.deepEqual(p.skipped, []);
  }
});

test("gate 3 reader: an unreadable event is bisected into skipped; the rest of its page is pushed, and it is not reported twice", { skip }, async () => {
  const head = (await q.queryStreamBounds()).head;
  // A redaction whose stored JSON does not parse: the touch page's jsonb cast
  // fails on that row only (SQLSTATE 22P02), as a corrupt row would.
  const bad = "$poison";
  await client.query("insert into local_media_repository values ('af1', $1), ('af2', $1)", [V]);
  await ev("!r1", "m.room.message", V, { msgtype: "m.image", url: mxc("af1") }, { ordering: head + 1 });
  await ev("!r1", "m.room.message", V, { msgtype: "m.image", url: mxc("af2") }, { ordering: head + 9 });
  const { reader, pushes, pool } = readerOn({ live: head, sweep: head + 100, lap_started_at: Date.now() });
  try {
    await client.query("insert into events (event_id, room_id, type, sender, stream_ordering, contains_url, received_ts) values ($1,'!tp','m.room.redaction',$2,$3,false,0)", [bad, V, head + 3]);
    await client.query("insert into event_json values ($1,'!tp','{not json')", [bad]);
    await reader.step();
    const first = pushes.filter((p) => p.stream === "live");
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].skipped, [{ stream_ordering: head + 3, event_id: bad, reason: "unreadable_redaction:22P02" }],
      "named as a redaction: its type is read from events, which does not need the JSON");
    assert.deepEqual(first[0].mxcs.map((m) => m.mxc), [mxc("af1"), mxc("af2")], "both sides of the poisoned row");
    assert.equal(first[0].to, head + 9);
    assert.equal(reader.health({ detail: true }).skipped.count, 1);
    // Caught up, the next poll re-reads the 500 ids below the cursor for
    // late commits. This process has not read below where it started, so
    // those are re-asked once (idempotent) -- but nothing it answered or
    // skipped itself is pushed or reported again.
    await reader.step();
    const second = pushes.filter((p) => p.stream === "live").slice(1);
    for (const p of second) {
      assert.deepEqual(p.skipped, [], "the poison is not reported twice");
      assert.ok(p.mxcs.every((m) => m.newest_ordering <= head), "nothing this reader already answered");
    }
    assert.equal(reader.health({ detail: true }).skipped.count, 1);
    const before = pushes.length;
    await reader.step();
    assert.equal(pushes.length, before, "a third poll with nothing new pushes nothing");
  } finally {
    await pool.end();
    await client.query("delete from event_json where event_id = $1", [bad]);
    await client.query("delete from events where event_id = $1", [bad]);
  }
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

// Scale is a requirement (GATE3_MATRIX_POSTS.md: "every new query is
// index-backed and its plan is shown"). On forty-row tables the planner picks
// whatever is cheapest for forty rows, so this loads a bulk of synthetic rows
// first -- 60,000 events (one in fifty an image), 60,000 current memberships
// over 5,000 rooms, 10,000 redactions, 20,000 profiles -- and requires the plan the planner
// chooses on its own, seqscans allowed. For the partial index that is also the
// proof that the query's WHERE implies its predicate. Runs after the test
// above built the indexes; the bulk is removed after.
test("gate 3: the new queries are index-backed -- the planner's own plan names each index", { skip }, async () => {
  const captured = [];
  const capture = makeQueries({ query: async (text, params) => { captured.push({ text, params }); return { rows: [{}] }; } }, { homeserverName: HS });
  const planOf = async (call) => {
    captured.length = 0;
    await call(capture).catch(() => {});
    const { text, params } = captured[0];
    const { rows } = await client.query(`explain ${text}`, params);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  };
  await client.query(`
    insert into events (event_id, room_id, type, sender, stream_ordering, contains_url, received_ts)
      select '$bulk' || g, '!bulk', case when g % 50 = 0 then 'm.room.message' else 'm.room.member' end,
             '@bulk:41chan.net', 1000000 + g, g % 50 = 0, 0
        from generate_series(1, 60000) g;
    insert into event_json
      select event_id, room_id, json_build_object('type', type, 'content',
               case when contains_url then json_build_object('url', 'mxc://41chan.net/bulk' || stream_ordering)
                    else json_build_object('membership', 'join') end)::text
        from events where event_id like '$bulk%';
    insert into current_state_events
      select '$cbulk' || g, '!room' || (g % 5000), 'm.room.member', '@u' || (g % 3000) || ':41chan.net', 'join'
        from generate_series(1, 60000) g;
    insert into redactions select '$rbulk' || g, '$bulk' || g, false, 0, false from generate_series(1, 30000, 3) g;
    insert into profiles select 'pbulk' || g, 'p', 'mxc://41chan.net/pbulk' || g, '@pbulk' || g || ':41chan.net' from generate_series(1, 20000) g;
    analyze;
  `);
  try {
    const touch = await planOf((c) => c.queryTouchPage(1000000, 1050000, 2000));
    assert.match(touch, /Index Scan using events_gate3_placement_idx/, touch);
    const joined = await planOf((c) => c.queryJoinedRoomsOf("@u7:41chan.net"));
    assert.match(joined, /current_state_events_member_index/, joined);
    const rooms = await planOf((c) => c.queryMediaRooms("mxc://41chan.net/bulk1000050", "@bulk:41chan.net"));
    assert.match(rooms, /redactions_redacts/, rooms);
    assert.match(rooms, /event_json_content_url_idx/, rooms);
    // The profiles arm: an image that is not an avatar (nearly every image)
    // read every profile row until profiles_avatar_url_idx (review 2026-10-15;
    // 9.6 ms of 9.6 at 100,000 profiles).
    const site = await planOf((c) => c.queryIsSiteAsset("mxc://41chan.net/bulk1000050", "@bulk:41chan.net", HS));
    assert.match(site, /profiles_avatar_url_idx/, site);
    assert.doesNotMatch(site, /Seq Scan on profiles/, site);
  } finally {
    await client.query(`
      delete from event_json where event_id like '$bulk%';
      delete from events where event_id like '$bulk%';
      delete from current_state_events where event_id like '$cbulk%';
      delete from redactions where event_id like '$rbulk%';
      delete from profiles where user_id like 'pbulk%';
    `);
  }
});

test("sampling gate: the room's CURRENT power levels, its name, and only the joined", { skip }, async () => {
  const r = await q.queryRoomGateState("!mods");
  assert.deepEqual(r.powerLevels, { users: { [V]: 100, [F]: 70, "@left:41chan.net": 90 }, users_default: 0 });
  assert.equal(r.name, "modsmodsmods");
  assert.deepEqual(r.joined, [F, V], "the leaver and the invitee are not joined");
});

test("sampling gate: a room this server does not hold reads as no power levels", { skip }, async () => {
  assert.deepEqual(await q.queryRoomGateState("!nowhere:41chan.net"), { powerLevels: null, name: null, joined: [] });
});
