-- sql/tarino-memory-seed.sql
--
-- Seed values for tarino's tenant_memory. Run AFTER chunk2b code is
-- deployed. The agent will use these on every run instead of re-deriving
-- them from web fetches.
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │ REVIEW EVERY VALUE BEFORE RUNNING.                                  │
-- │                                                                     │
-- │ These are reasonable starter guesses based on tarino.au but YOU     │
-- │ are the brand owner. The agent will rely on these as ground truth — │
-- │ wrong values mean wrong content. Edit to match how you actually     │
-- │ want the agent to think about tarino.                               │
-- └─────────────────────────────────────────────────────────────────────┘
--
-- The link-map entry (#7) intentionally has a placeholder JSON — the agent
-- will populate this on its first run (memory protocol records it after
-- calling framer_list_blog_items).
--
-- Idempotent: ON CONFLICT updates instead of erroring, so you can re-run
-- after editing.

BEGIN;

-- ── 1. Brand voice — most important. Skips /about + sample-posts re-fetch.
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'preference',
  'brand-voice',
  'Direct, plain-English, slightly contrarian when warranted. Uses concrete AUD figures and specific examples — not "we save you money" but "Manila senior dev fully loaded: $85K AUD vs Sydney senior at $180K AUD." Avoids buzzwords (synergy, leverage, paradigm, optimise). Leads with the bottom line; setup paragraphs go at the end if at all. Writes for time-poor SMB founders comparing options, not for search engines. Subheads are assertions or questions, not noun phrases. Lists used sparingly; prose carries more weight.',
  0.75, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 2. Target audience
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'fact',
  'target-audience',
  'Australian SMB founders, ~2-50 person teams, $1M-$20M revenue. Often non-technical or semi-technical (operators, GMs, ops leads). Decision-stage buyers — already know they need offshore talent, comparing how to source it (in-house remote vs agency vs marketplace vs us). Time-poor; if a post does not earn the first 200 words, they bounce. Skeptical of recruitment-agency marketing fluff; respond to specific costs, specific timelines, specific risks.',
  0.75, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 3. Commercial lane — what does tarino actually sell?
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'fact',
  'commercial-lane',
  'Tarino sources offshore talent for Australian businesses. Revenue model: full-service recruitment + onboarding for offshore hires (mainly Philippines but flexible). Not a marketplace, not a job board, not a staffing agency that places contractors. We own the relationship end-to-end so the client gets a high-quality hire who works like an employee. Closest competitor positioning: Cloudstaff, Beepo, Hammerjack.',
  0.70, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 4. Constraint: no cheap-labor positioning
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'constraint',
  'positioning-not-cheap-labor',
  'Do NOT pitch tarino on cost-savings alone. Positioning is QUALITY offshore talent matched well, NOT cheap labor. Cost should appear only in context of value (e.g. "$80K AUD senior dev who gets the same output as a $180K AUD Sydney senior") — never as the lead-in or main argument. The cheap-labor framing is short-term and attracts wrong-fit clients who churn.',
  0.85, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 5. Constraint: don't fearmonger about Australian hiring
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'constraint',
  'no-fearmongering',
  'Do NOT open posts with "you''re struggling to hire locally" or "the Australian talent market is broken" or similar fear-based hooks. The audience has already decided to look offshore — they''re comparing HOW, not WHETHER. Treat the reader as already-decided. Skip the problem section; go straight to the comparison or decision framework.',
  0.80, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 6. Decision: writing length and structure
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'decision',
  'writing-length-cadence',
  'Resource pieces: 800-1200 words target, 1500 max for comparison-format pieces. Listicles 600-800. Anything longer fragments attention. Publishing cadence: 1-2 resource pieces per week — quality > quantity. Topic concentration: better to publish two strong pieces on related topics in the same week than five scattered ones.',
  0.70, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 7. Link map placeholder — agent fills this on first run
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'fact',
  'link-map-resources',
  '{"refreshed_at": "1970-01-01", "internal_links": []}',
  0.10, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

-- ── 8. Decision: outbound CTA pattern
INSERT INTO tenant_memory (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id)
VALUES (
  gen_random_uuid(),
  'tarino',
  'decision',
  'cta-pattern',
  'End resource pieces with a soft CTA — not a hard pitch. Pattern: a 1-2 sentence line that names what the reader could do next (book a discovery call to scope a specific hire, or read a related resource) and provides a single clear link. No buttons, no "schedule your free consultation today!", no urgency. The audience is decision-stage; they''ll act when ready.',
  0.65, 1, 'seed-2026-05-16-tarino'
) ON CONFLICT (tenant_id, type, key) DO UPDATE
  SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, updated_at = NOW();

COMMIT;

-- Verify the seed
SELECT type, key, LEFT(value, 80) || '...' AS preview, confidence
  FROM tenant_memory
 WHERE tenant_id = 'tarino' AND source_run_id LIKE 'seed-%'
 ORDER BY type, key;
