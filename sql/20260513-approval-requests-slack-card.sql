-- Add Slack card tracking columns to approval_requests so that the
-- "Needs your call" Block Kit card can be updated in-place when the
-- operator approves or rejects.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS slack_message_ts  TEXT,
  ADD COLUMN IF NOT EXISTS slack_channel_id  TEXT;
