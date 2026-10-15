-- Indexes fourier-auth NEEDS on Synapse's database, declared here because
-- Synapse does not know about them and would not recreate them.
--
-- mediaauth.js answers "is this mxc a site asset?" and "which rooms contain
-- it?" by matching a JSON path inside event_json.json. Without these, each
-- question is a sequential scan of event_json with a jsonb parse per row:
-- measured 2026-09-05 at 1,412 ms and 1,849 ms per cold image on a 234 MB
-- table, through a pool of four connections with a five-second deadline --
-- which is where 105 fail-closed 403s a day were coming from. With them:
-- 38 ms and 18 ms.
--
-- Idempotent and non-blocking: IF NOT EXISTS makes re-running a no-op, and
-- CONCURRENTLY builds without locking writes. CONCURRENTLY cannot run inside a
-- transaction, so apply this file with autocommit (plain psql -f), never
-- wrapped in BEGIN. tools/ensure-synapse-indexes.sh does that and then
-- verifies every index below exists AND is valid -- a CONCURRENTLY build that
-- fails leaves an INVALID index behind that looks present and does nothing.
--
-- Expression must match the query text exactly (json::jsonb #>> '{...}') or
-- the planner will not use it.

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_json_content_url_idx
  ON event_json ((json::jsonb #>> '{content,url}'));

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_json_content_avatar_url_idx
  ON event_json ((json::jsonb #>> '{content,avatar_url}'));

CREATE INDEX CONCURRENTLY IF NOT EXISTS event_json_content_thumbnail_url_idx
  ON event_json ((json::jsonb #>> '{content,info,thumbnail_url}'));

-- The remaining scan. The room-avatar and emoji-pack branches of isSiteAsset
-- filter events by type first, and Synapse has no index on events.type, so
-- each was a full scan of events (220k rows, ~40-80 ms) -- and events only
-- ever grows, which is how a fix that works today stops working next year.
-- Partial, over just those rare types: a few hundred rows, not two hundred
-- thousand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_site_asset_types_idx
  ON events (type)
  WHERE type IN ('m.room.avatar', 'im.ponies.room_emotes', 'im.ponies.user_emotes', 'm.image_pack');

-- The profiles arm of isSiteAsset (an account avatar) matches avatar_url, and
-- Synapse indexes profiles by user only, so every image that is NOT a site
-- asset -- nearly all of them -- read every profile row. Measured 2026-10-15 on
-- a bed of 100,000 profiles: 9.6 ms per image, all of it that seq scan, and the
-- gate 3 reader asks once per image per sweep lap (1,000,000 images is ~2.7 h
-- of one connection a lap, growing with every account). A plain btree: the
-- query compares the column itself, so no expression is needed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS profiles_avatar_url_idx
  ON profiles (avatar_url);

-- Gate 3 for posts (fourier-basis docs/design/GATE3_CONTRACTS.md A2): the
-- placements reader walks Synapse's events in stream order from a cursor and
-- needs only the events that can move an image's answer -- image messages,
-- stickers, room avatars, and redactions. Partial, so it holds those rows and
-- not the whole timeline: a 50,000-id window of chat is a handful of index
-- entries. The reader's WHERE repeats this predicate exactly; the planner uses
-- a partial index only when it can prove the query implies it. Must exist
-- BEFORE GATE3_READER=on, or every page is a scan of events.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_gate3_placement_idx
  ON events (stream_ordering)
  WHERE (contains_url AND type IN ('m.room.message', 'm.sticker', 'm.room.avatar'))
     OR type = 'm.room.redaction';

-- Statistics, or the indexes above are decoration. A freshly built expression
-- index has NO statistics until the table is analyzed, so the planner guessed
-- ~1,100 rows per url (actual: 1) and hash-joined by scanning all of events
-- rather than probing it -- resolveMediaRooms stayed at 30 ms and linear in a
-- table that only grows, with every index in place. ANALYZE brought it to
-- 0.8 ms. Autovacuum maintains the statistics from here; this is for the
-- first run on a fresh database, which is exactly when nobody would think to.
ANALYZE event_json;
ANALYZE events;
