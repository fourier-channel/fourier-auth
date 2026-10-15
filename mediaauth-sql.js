"use strict";

// The SQL half of the media decision: every query fourier-auth asks of
// Synapse's own Postgres, as functions of a client. Separate from mediaauth.js
// (which owns the real pool, Redis and Synapse's HTTP API) so the queries can
// be run against a real Postgres by mediaauth-sql.test.js without loading any
// of that.
//
// Every function RETURNS for an answer and THROWS for "could not find out";
// mediaauth-core.js relies on that contract to tell an outage from a denial.

function makeQueries(db, { homeserverName = "41chan.net" } = {}) {
  // Who uploaded a LOCAL media id (local_media_repository.user_id), or null for
  // remote media and for a media id with no record. The uploader is what makes
  // a reference to an mxc mean something (leak audit F-G3/F-G4, 2026-10-01):
  // anyone who learns an mxc can paste it into an avatar or a message, but only
  // the uploader's own references say where the image was meant to be seen.
  // Needs SELECT on local_media_repository (db/synapse-grants.sql).
  async function queryUploader(serverName, mediaId) {
    if (serverName !== homeserverName) return null;
    const { rows } = await db.query(
      `select user_id from local_media_repository where media_id = $1`,
      [mediaId]
    );
    return rows.length > 0 && typeof rows[0].user_id === "string" ? rows[0].user_id : null;
  }

  // Site asset: an avatar (profile or member event), a room icon, or an image in
  // an emoji pack (im.ponies.* / m.image_pack -- a reaction image is chrome too)
  // -- SET BY ITS UPLOADER. $2 is the uploader (null = no record: the old rule,
  // any reference counts). Before the uploader clause, a member who learned the
  // mxc of a DM image could set it as their own avatar and make it readable to
  // every signed-in user, themselves included (F-G3). $3 is the homeserver name,
  // for a profile row older than profiles.full_user_id.
  //
  // A REDACTED event states nothing (ruled 2026-10-15: deleting a message hides
  // its image at once). Synapse prunes a redacted member event to its
  // membership, a room avatar and an emote pack to nothing, so once it scrubs
  // the stored copy (~7 days later) these arms stop matching anyway; the
  // anti-join makes that true the moment the redaction is persisted instead of
  // a week later, so the image's answer does not change twice. The profiles
  // arm has no event to redact. Needs SELECT on redactions.
  async function queryIsSiteAsset(mxc, uploader = null, serverName = homeserverName) {
    const { rows } = await db.query(
      `select 1 where exists (select 1 from profiles p where p.avatar_url = $1
                                and ($2::text is null or p.full_user_id = $2
                                     or '@' || p.user_id || ':' || $3 = $2))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                      where e.type = 'm.room.member'
                        and ej.json::jsonb #>> '{content,avatar_url}' = $1
                        and ($2::text is null or e.sender = $2)
                        and not exists (select 1 from redactions r where r.redacts = e.event_id))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                      where e.type = 'm.room.avatar'
                        and ej.json::jsonb #>> '{content,url}' = $1
                        and ($2::text is null or e.sender = $2)
                        and not exists (select 1 from redactions r where r.redacts = e.event_id))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id,
                          lateral jsonb_each(coalesce(ej.json::jsonb #> '{content,images}', '{}'::jsonb)) img
                      where e.type in ('im.ponies.room_emotes', 'im.ponies.user_emotes', 'm.image_pack')
                        and img.value ->> 'url' = $1
                        and ($2::text is null or e.sender = $2)
                        and not exists (select 1 from redactions r where r.redacts = e.event_id))
        limit 1`,
      [mxc, uploader, serverName]
    );
    return rows.length > 0;
  }

  // Every place an mxc can legitimately appear: message bodies and stickers
  // (content.url and the thumbnail_url inside info -- a thumbnail is a different
  // mxc from its original), room avatars, and member avatars. Missing the avatar
  // forms is what once 403'd every profile picture the moment Synapse's own
  // fall-through was closed.
  //
  // WHO PUT IT THERE (F-G3). A placement counts when its sender is the uploader
  // ($2). A MESSAGE or sticker sent by someone else counts when that sender has
  // been joined to a room where the uploader placed it -- a forward, which
  // Element sends by reference. An avatar set to someone else's upload never
  // counts: that was the way to read a DM image by setting it as your own member
  // avatar, or as the avatar of a room you made. $2 null (remote media, or no
  // upload record) keeps the old rule. A forward of a forward, by someone never
  // in a room the uploader posted to, does not count; recorded, not an oversight.
  // Needs SELECT on room_memberships (db/synapse-grants.sql).
  //
  // A REDACTED placement does not count (operator ruling 2026-10-15: deleting
  // a message hides its image at once -- for the image and so for the post --
  // not when Synapse scrubs the content ~7 days later). The anti-join is on the
  // candidate set, so it holds on EVERY arm and on both sides of the forward
  // rule: an uploader who deletes their post also stops vouching for forwards
  // made by members of that room. It reads Synapse's redactions table as
  // Synapse fills it: a local redaction is checked at send (the sender's own
  // event, or redact power) and a rejected one is never stored, so a row is a
  // redaction Synapse honours. A federated redaction Synapse would later
  // withhold (recheck) is counted here -- that can only narrow, and federation
  // is off. Index redactions_redacts. Needs SELECT on redactions.
  async function queryMediaRooms(mxc, uploader = null) {
    const { rows } = await db.query(
      `with candidates as (
         select e.event_id, e.room_id, e.sender, e.type
           from events e
           join event_json ej on e.event_id = ej.event_id
          where (e.type in ('m.room.message', 'm.sticker')
                  and (ej.json::jsonb #>> '{content,url}' = $1
                    or ej.json::jsonb #>> '{content,info,thumbnail_url}' = $1))
             or (e.type = 'm.room.avatar' and ej.json::jsonb #>> '{content,url}' = $1)
             or (e.type = 'm.room.member' and ej.json::jsonb #>> '{content,avatar_url}' = $1)
       ),
       placed as (
         select c.room_id, c.sender, c.type
           from candidates c
          where not exists (select 1 from redactions r where r.redacts = c.event_id)
       )
       select distinct p.room_id
         from placed p
        where $2::text is null
           or p.sender = $2
           or (p.type in ('m.room.message', 'm.sticker')
               and exists (select 1
                             from placed q
                             join room_memberships m on m.room_id = q.room_id
                            where q.sender = $2
                              and m.user_id = p.sender
                              and m.membership = 'join'))`,
      [mxc, uploader]
    );
    return rows.map((r) => r.room_id);
  }

  // Has this user EVER been joined to this room? The encrypted-room hint's
  // second condition (F-G4): the image's uploader must have been in the room
  // the reader names, or the hint names a room the image was never posted to.
  async function queryUploaderJoined(roomId, userId) {
    const { rows } = await db.query(
      `select 1 from room_memberships
        where room_id = $1 and user_id = $2 and membership = 'join' limit 1`,
      [roomId, userId]
    );
    return rows.length > 0;
  }

  async function queryIsEncrypted(roomId) {
    const { rows } = await db.query(
      `select 1 from current_state_events
        where room_id = $1 and type = 'm.room.encryption' and state_key = '' limit 1`,
      [roomId]
    );
    return rows.length > 0;
  }

  // The sampling gate's question (operator ruling 2026-10-09): one room's
  // CURRENT power levels, its name, and who is joined to it now. Read from
  // current_state_events -- the room as Synapse resolves it today, never a
  // historical event -- in one round trip, because the gate asks it for every
  // console request (sample-gate.js caches it). powerLevels is null when the
  // room has no power-levels event on this server (a wrong room id), which the
  // gate treats as misconfiguration, not as "nobody qualifies". Needs SELECT on
  // current_state_events and event_json, both in the role's original grant.
  async function queryRoomGateState(roomId) {
    const { rows } = await db.query(
      `select
         (select ej.json::jsonb -> 'content'
            from current_state_events c join event_json ej on ej.event_id = c.event_id
           where c.room_id = $1 and c.type = 'm.room.power_levels' and c.state_key = '') as power_levels,
         (select ej.json::jsonb #>> '{content,name}'
            from current_state_events c join event_json ej on ej.event_id = c.event_id
           where c.room_id = $1 and c.type = 'm.room.name' and c.state_key = '') as name,
         (select coalesce(array_agg(c.state_key order by c.state_key), '{}')
            from current_state_events c
           where c.room_id = $1 and c.type = 'm.room.member' and c.membership = 'join') as joined`,
      [roomId]
    );
    const r = rows[0] || {};
    return { powerLevels: r.power_levels || null, name: r.name || null, joined: r.joined || [] };
  }

  // Gate 3 for posts (GATE3_CONTRACTS.md A1): the rooms one user is joined to
  // NOW, for /verify?gate=rooms. current_state_events, never room_memberships:
  // room_memberships is history -- it keeps the join row of a user who has
  // since left -- and a left room must stop showing its posts. Checked on
  // production 2026-10-15: equal to Synapse's local_current_membership joins
  // for all 43 local users. Index current_state_events_member_index (Synapse's
  // own, partial on type = 'm.room.member', keyed by state_key). Callers sort
  // again: the digest is over the list as sent, and the order must not depend
  // on the database's collation.
  async function queryJoinedRoomsOf(mxid) {
    const { rows } = await db.query(
      `select room_id from current_state_events
        where type = 'm.room.member' and state_key = $1 and membership = 'join'
        order by room_id`,
      [mxid]
    );
    return rows.map((r) => r.room_id);
  }

  // -- the placements reader (placements-reader.js, GATE3_CONTRACTS.md A2) ---
  //
  // Asked inside ONE repeatable-read, read-only transaction per page, so the
  // head, the touched events and every per-image answer describe the same
  // instant -- which is what makes "the newer snapshot wins" at the booru a
  // correct rule rather than a hopeful one. Stream orderings come back from pg
  // as strings when the column is bigint; they are converted here, once.

  const ordering = (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error(`stream_ordering ${JSON.stringify(v)} is not a safe integer`);
    return n;
  };

  // Synapse's head and tail (backfilled events have NEGATIVE orderings, so the
  // tail is below zero on any server that has backfilled) and the database's
  // clock at the snapshot. Both ends read events_stream_ordering (unique).
  async function queryStreamBounds() {
    const { rows } = await db.query(
      `select (select max(stream_ordering) from events) as head,
              (select min(stream_ordering) from events) as tail,
              (extract(epoch from now()) * 1000)::bigint as at`
    );
    const r = rows[0] || {};
    return {
      head: r.head === null || r.head === undefined ? 0 : ordering(r.head),
      tail: r.tail === null || r.tail === undefined ? 0 : ordering(r.tail),
      at: ordering(r.at),
    };
  }

  // The touch page, as the contract states it. The WHERE repeats the predicate
  // of events_gate3_placement_idx (db/synapse-indexes.sql) word for word,
  // because the planner uses a partial index only when it can prove the query
  // implies it. contains_url is set by Synapse's one insert path for every
  // event -- outliers and backfill included (read from Synapse 1.152.1
  // storage/databases/main/events.py _store_event_txn) -- so the sweep needs
  // no second form for outlier ranges.
  async function queryTouchPage(from, to, limit) {
    const { rows } = await db.query(
      `select e.stream_ordering, e.event_id, e.type, e.room_id, e.sender,
              ej.json::jsonb #>> '{content,url}' as url,
              coalesce(ej.json::jsonb #>> '{content,redacts}', ej.json::jsonb ->> 'redacts') as redacts
         from events e join event_json ej on ej.event_id = e.event_id
        where e.stream_ordering > $1 and e.stream_ordering <= $2
          and ((e.contains_url and e.type in ('m.room.message','m.sticker','m.room.avatar'))
               or e.type = 'm.room.redaction')
        order by e.stream_ordering limit $3`,
      [from, to, limit]
    );
    return rows.map((r) => ({ ...r, stream_ordering: ordering(r.stream_ordering) }));
  }

  // The event at one ordering -- its id and type, without touching its JSON:
  // how a poisoned row is named once bisection has cornered it, and whether it
  // was a redaction (a deleted post that may stay visible, said apart).
  async function queryEventAt(streamOrdering) {
    const { rows } = await db.query(`select event_id, type from events where stream_ordering = $1`, [streamOrdering]);
    return rows.length > 0 ? { event_id: rows[0].event_id, type: rows[0].type } : null;
  }

  // What a redaction took away: the target's content.url, by event id. Read
  // before Synapse scrubs it (~7 days); after that the target carries no url
  // and there is nothing to re-ask from it.
  async function queryRedactionTargets(eventIds) {
    if (eventIds.length === 0) return new Map();
    const { rows } = await db.query(
      `select ej.event_id, ej.json::jsonb #>> '{content,url}' as url
         from event_json ej where ej.event_id = any($1::text[])`,
      [eventIds]
    );
    return new Map(rows.map((r) => [r.event_id, r.url]));
  }

  // Uploaders of many local media ids in one round trip, null for no record --
  // the same fact queryUploader gives the image gate one id at a time.
  async function queryUploaders(mediaIds) {
    if (mediaIds.length === 0) return new Map();
    const { rows } = await db.query(
      `select media_id, user_id from local_media_repository where media_id = any($1::text[])`,
      [mediaIds]
    );
    return new Map(rows.map((r) => [r.media_id, typeof r.user_id === "string" ? r.user_id : null]));
  }

  // When the oldest event the reader has not read yet arrived: its lag in
  // seconds is how long that event has waited, a measurement, not a guess.
  async function queryFirstReceivedAfter(streamOrdering) {
    const { rows } = await db.query(
      `select received_ts from events where stream_ordering > $1 order by stream_ordering limit 1`,
      [streamOrdering]
    );
    return rows.length > 0 && rows[0].received_ts !== null ? Number(rows[0].received_ts) : null;
  }

  return {
    queryUploader, queryIsSiteAsset, queryMediaRooms, queryUploaderJoined, queryIsEncrypted, queryRoomGateState,
    queryJoinedRoomsOf,
    queryStreamBounds, queryTouchPage, queryEventAt, queryRedactionTargets, queryUploaders, queryFirstReceivedAfter,
  };
}

module.exports = { makeQueries };
