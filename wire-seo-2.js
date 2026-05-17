// wire-seo-2-auditor.js
//
// Applies 4 file edits to integrate SEO-2 into the existing system:
//   - src/scheduler/types.ts: add 'seo_audit' to RunKind union
//   - src/scheduler/worker.ts: import runFullAuditCycle + add seo_audit fork
//   - src/scheduler/config.ts: add DEFAULT_SCHEDULES.seo_audit + register
//   - db/migrate.ts: import + call runSeo2AuditorMigration
//
// Idempotent (each edit guarded). Outputs progress per edit.

const fs = require('fs');

function patch(file, anchor, replacement, label) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(replacement.split('\n')[0]) && !s.includes(anchor)) {
    console.log(`  ${label}: already applied`);
    return;
  }
  if (!s.includes(anchor)) {
    console.error(`  ${label}: anchor not found`);
    process.exit(1);
  }
  s = s.replace(anchor, replacement);
  fs.writeFileSync(file, s);
  console.log(`  ${label}: applied`);
}

// ── Edit 1: scheduler/types.ts ─────────────────────────────────────
console.log('Editing src/scheduler/types.ts');
{
  const file = 'src/scheduler/types.ts';
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes("'seo_audit'")) {
    console.log('  RunKind: already extended');
  } else {
    const anchor = `export type RunKind = 'daily' | 'weekly' | 'end-of-week'`;
    const repl   = `export type RunKind = 'daily' | 'weekly' | 'end-of-week' | 'seo_audit'`;
    if (!s.includes(anchor)) { console.error('  RunKind anchor not found'); process.exit(1); }
    fs.writeFileSync(file, s.replace(anchor, repl));
    console.log('  RunKind: extended');
  }
}

// ── Edit 2: scheduler/worker.ts ─────────────────────────────────────
console.log('Editing src/scheduler/worker.ts');
{
  const file = 'src/scheduler/worker.ts';
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('runFullAuditCycle')) {
    console.log('  worker.ts: already wired');
  } else {
    // Add import. Find an existing scheduler-related import block and append after it.
    const importAnchor = `import { getTenant } from '../tenants/registry'`;
    const importRepl = importAnchor +
      `\nimport { runFullAuditCycle } from '../skills/seo-technical-auditor'`;
    if (!s.includes(importAnchor)) {
      console.error('  worker.ts: import anchor not found (expected `getTenant` import)');
      process.exit(1);
    }
    s = s.replace(importAnchor, importRepl);

    // Insert the seo_audit branch after the inactive-skip check.
    const forkAnchor = `  if (!tenant.isActive) {
    logger.info('schedule_skipped_tenant_inactive', { tenantId });
    return;
  }`;
    const forkRepl = forkAnchor + `

  // seo_audit runs its own cycle (crawl + audit + memory) directly — does
  // NOT go through the orchestrator/aggregator. The next daily run consumes
  // the findings + opportunities the audit produced.
  if (runKind === 'seo_audit') {
    logger.info('seo_audit_cycle_starting', { tenantId });
    try {
      await runFullAuditCycle(tenantId);
      logger.info('seo_audit_cycle_completed', { tenantId });
    } catch (err) {
      logger.error('seo_audit_cycle_failed', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }`;
    if (!s.includes(forkAnchor)) {
      console.error('  worker.ts: fork anchor not found');
      process.exit(1);
    }
    s = s.replace(forkAnchor, forkRepl);
    fs.writeFileSync(file, s);
    console.log('  worker.ts: wired (import + seo_audit fork)');
  }
}

// ── Edit 3: scheduler/config.ts ─────────────────────────────────────
console.log('Editing src/scheduler/config.ts');
{
  const file = 'src/scheduler/config.ts';
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('seo_audit')) {
    console.log('  config.ts: already extended');
  } else {
    // 3a: add to DEFAULT_SCHEDULES
    const dsAnchor = `  weekly: {
    cronExpr: '0 8 * * 1',          // 8am Monday
    timezone: 'Australia/Sydney',
  },
} as const`;
    const dsRepl = `  weekly: {
    cronExpr: '0 8 * * 1',          // 8am Monday
    timezone: 'Australia/Sydney',
  },
  seo_audit: {
    cronExpr: '0 0 * * 6',          // midnight Saturday (Sydney)
    timezone: 'Australia/Sydney',
  },
} as const`;
    if (!s.includes(dsAnchor)) {
      console.error('  config.ts: DEFAULT_SCHEDULES anchor not found');
      process.exit(1);
    }
    s = s.replace(dsAnchor, dsRepl);

    // 3b: register seo_audit in applyDefaultSchedulesFor
    const applyAnchor = `  await upsertSchedule({
    tenantId,
    runKind: 'daily',
    cronExpr: DEFAULT_SCHEDULES.daily.cronExpr,
    timezone: DEFAULT_SCHEDULES.daily.timezone,
  })`;
    const applyRepl = applyAnchor + `
  await upsertSchedule({
    tenantId,
    runKind: 'seo_audit',
    cronExpr: DEFAULT_SCHEDULES.seo_audit.cronExpr,
    timezone: DEFAULT_SCHEDULES.seo_audit.timezone,
  })`;
    if (!s.includes(applyAnchor)) {
      console.error('  config.ts: applyDefaultSchedulesFor anchor not found');
      process.exit(1);
    }
    s = s.replace(applyAnchor, applyRepl);
    fs.writeFileSync(file, s);
    console.log('  config.ts: wired (DEFAULT_SCHEDULES + applyDefaultSchedulesFor)');
  }
}

// ── Edit 4: db/migrate.ts ──────────────────────────────────────────
console.log('Editing db/migrate.ts');
{
  const file = 'db/migrate.ts';
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes('runSeo2AuditorMigration')) {
    console.log('  migrate.ts: already wired');
  } else {
    const importAnchor = `import { runSeo1CrawlerMigration } from './migrations/seo-1-crawler'`;
    const importRepl = importAnchor +
      `\nimport { runSeo2AuditorMigration } from './migrations/seo-2-auditor'`;
    if (!s.includes(importAnchor)) {
      console.error('  migrate.ts: SEO-1 import anchor not found (run SEO-1 wiring first)');
      process.exit(1);
    }
    s = s.replace(importAnchor, importRepl);

    const callAnchor = `  await runSeo1CrawlerMigration(pool)`;
    const callRepl = callAnchor + `\n  await runSeo2AuditorMigration(pool)`;
    if (!s.includes(callAnchor)) {
      console.error('  migrate.ts: SEO-1 call anchor not found');
      process.exit(1);
    }
    s = s.replace(callAnchor, callRepl);
    fs.writeFileSync(file, s);
    console.log('  migrate.ts: wired (import + call)');
  }
}

console.log('\nAll edits applied.');
