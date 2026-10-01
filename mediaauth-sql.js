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
  async function queryIsSiteAsset(mxc, uploader = null, serverName = homeserverName) {
    const { rows } = await db.query(
      `select 1 where exists (select 1 from profiles p where p.avatar_url = $1
                                and ($2::text is null or p.full_user_id = $2
                                     or '@' || p.user_id || ':' || $3 = $2))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                      where e.type = 'm.room.member'
                        and ej.json::jsonb #>> '{content,avatar_url}' = $1
                        and ($2::text is null or e.sender = $2))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id
                      where e.type = 'm.room.avatar'
                        and ej.json::jsonb #>> '{content,url}' = $1
                        and ($2::text is null or e.sender = $2))
          or exists (select 1 from events e join event_json ej on e.event_id = ej.event_id,
                          lateral jsonb_each(coalesce(ej.json::jsonb #> '{content,images}', '{}'::jsonb)) img
                      where e.type in ('im.ponies.room_emotes', 'im.ponies.user_emotes', 'm.image_pack')
                        and img.value ->> 'url' = $1
                        and ($2::text is null or e.sender = $2))
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
  async function queryMediaRooms(mxc, uploader = null) {
    const { rows } = await db.query(
      `with placed as (
         select e.room_id, e.sender, e.type
           from events e
           join event_json ej on e.event_id = ej.event_id
          where (e.type in ('m.room.message', 'm.sticker')
                  and (ej.json::jsonb #>> '{content,url}' = $1
                    or ej.json::jsonb #>> '{content,info,thumbnail_url}' = $1))
             or (e.type = 'm.room.avatar' and ej.json::jsonb #>> '{content,url}' = $1)
             or (e.type = 'm.room.member' and ej.json::jsonb #>> '{content,avatar_url}' = $1)
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

  return { queryUploader, queryIsSiteAsset, queryMediaRooms, queryUploaderJoined, queryIsEncrypted };
}

module.exports = { makeQueries };
