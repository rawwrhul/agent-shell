-- Cost-efficiency (2026-07-24): per-tenant cap on propose_action calls per
-- daily generation run (article included). NULL = default playbook counts.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS daily_action_cap integer;

-- Tarino: run lean — one article + up to 3 on-page actions per day.
UPDATE tenants SET daily_action_cap = 4, updated_at = NOW() WHERE tenant_id = 'tarino';

-- Tarino: single daily generation run (morning only). The schedule
-- reconciler removes the Redis repeatable on its next tick.
UPDATE tenant_schedules SET enabled = false, updated_at = NOW()
 WHERE tenant_id = 'tarino' AND run_kind = 'daily_pm';
