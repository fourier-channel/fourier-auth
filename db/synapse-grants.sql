-- Table privileges fourier-auth's read-only role NEEDS on Synapse's database,
-- beyond what it was first given (events, event_json, profiles,
-- current_state_events). Declared here because a privilege applied by hand on
-- the box is a change nobody can see (db-changes-must-live-in-a-repo).
--
-- Added 2026-10-01 for the leak audit's F-G3 and F-G4. A reference to an mxc
-- (an avatar, a room icon, a message) now counts only when it was made by the
-- media's UPLOADER -- or, for a message, by someone who has been in a room the
-- uploader posted it to -- and the encrypted-room hint only names a room the
-- uploader has been in. Both questions need:
--
--   local_media_repository  who uploaded a media id (user_id)
--   room_memberships        who has ever been joined to a room
--
-- Without them every Matrix media decision throws, and the gate answers 503
-- for every picture: apply this BEFORE restarting a gate that needs it.
-- tools/ensure-synapse-indexes.sh applies and verifies it; the service checks
-- the privileges at boot and reports them on /healthz.
--
-- Idempotent: GRANT of a privilege already held is a no-op.

GRANT SELECT ON local_media_repository TO fourier_auth_ro;
GRANT SELECT ON room_memberships TO fourier_auth_ro;
