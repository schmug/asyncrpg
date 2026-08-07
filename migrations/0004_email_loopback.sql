-- Verification loopback for the inbound email path.
--
-- The inbound SMTP hop was the one rung of the verification ladder that could
-- not be proven: doing so needs a mailbox on a Cloudflare-verified domain that
-- the harness can read back, and pointing test mail at the domain owner's real
-- forwarding address is not acceptable.
--
-- The owner has several onboarded domains, which resolves it. A reserved
-- address on a *different* zone from the game's own inbox receives real beats
-- through real Email Routing, records them here, and replies — so the test can
-- assert on bytes that actually traversed Cloudflare's mail path twice, rather
-- than on a synthetic message handed straight to the handler.
CREATE TABLE IF NOT EXISTS email_loopback (
  id          TEXT PRIMARY KEY,
  direction   TEXT NOT NULL CHECK (direction IN ('received', 'replied')),
  to_address  TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  message_id  TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loopback_created ON email_loopback(created_at DESC);
