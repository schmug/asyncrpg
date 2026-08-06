-- Every inbound message the handler sees, and what it decided.
--
-- Without this, a reply that does not become a turn is indistinguishable from
-- a reply that never arrived: both look like silence. The email E2E gate hit
-- exactly that ambiguity — "the reply never reached the handler" was the only
-- thing it could say, when the real question is which of four different
-- failures happened (routing never delivered it, the handler rejected it,
-- DMARC/identity did not line up, or the submission to the DO failed).
--
-- Bounded by design: this is an operational audit trail, not history. Rows are
-- pruned to the most recent few hundred per the pruning in the handler.
CREATE TABLE IF NOT EXISTS inbound_log (
  id           TEXT PRIMARY KEY,
  to_address   TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  -- 'accepted' | 'rejected' | 'loopback'
  disposition  TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  campaign_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_log_time ON inbound_log(created_at);
