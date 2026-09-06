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
