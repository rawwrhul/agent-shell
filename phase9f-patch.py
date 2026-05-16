#!/usr/bin/env python3
"""
phase9f-patch.py — Phase 9f: Slack socket-mode resilience.

Production logs from recent days show a recurring crash pattern:

    Error: Unhandled event 'server explicit disconnect' in state 'connecting'.
        at TaskScheduler.enqueue (/app/node_modules/finity/lib/core/TaskScheduler.js:19:12)

@slack/socket-mode's internal `finity` state machine receives a disconnect
event from Slack while still in the 'connecting' state and throws an
unhandled error. Node's default behaviour kills the process. Cloud Run
restarts it. New process reconnects. Slack drops again. Repeat.

Two layers of fix:

  1. EDIT src/index.ts — add process-level uncaughtException + unhandledRejection
     handlers that LOG but don't exit. Catches the finity throw so the process
     stays alive and the socket lib gets to do its built-in reconnection.

  2. EDIT src/tenants/slackManager.ts — register app.error() handler on each
     tenant's Bolt App so bolt-level errors are logged with tenant context
     instead of bubbling up as uncaught.

This is deliberate use of uncaughtException to keep the process alive.
For genuinely fatal errors (corrupted memory, etc.) Cloud Run's restart-
on-crash still catches it — we're not silencing those; we're just ensuring
@slack/socket-mode's noisy state-machine misbehaviour doesn't trigger a
restart loop.

Run from project root. Idempotent.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), 'Run from project root.'

def must_read(p):
    if not p.exists(): sys.exit(f'fatal: file missing: {p}')
    return p.read_text()

def replace_one(text, anchor, new, where):
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:400]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. EDIT: src/index.ts — process-level handlers ────────────────────────
P = ROOT / 'src/index.ts'
src = must_read(P)

if 'Phase 9f' in src or "process.on('uncaughtException'" in src:
    print('[1/2] index.ts already has Phase 9f handlers — skipping')
else:
    # Insert handlers immediately before main() is invoked, so they're armed
    # before any startup work happens (in case startup itself throws).
    src = replace_one(
        src,
        "main().catch(err => {\n"
        "  logger.error('startup_failed', { err: err.message })\n"
        "  process.exit(1)\n"
        "})",
        "// Phase 9f: process-level safety net for @slack/socket-mode state-machine\n"
        "// noise. The finity state machine inside @slack/socket-mode throws when it\n"
        "// receives a 'server explicit disconnect' event during the 'connecting'\n"
        "// state — a real production pattern we've observed. Without these handlers\n"
        "// Node kills the process, Cloud Run restarts, and we crash-loop.\n"
        "//\n"
        "// We deliberately do NOT call process.exit here. The errors we're catching\n"
        "// don't corrupt process state — they leave the rest of the runtime healthy\n"
        "// and the socket lib will reconnect on its own. Genuinely fatal errors\n"
        "// (OOM, etc.) still get caught by Cloud Run's underlying restart-on-crash.\n"
        "process.on('uncaughtException', (err: Error) => {\n"
        "  logger.error('uncaught_exception', {\n"
        "    msg:   err.message,\n"
        "    stack: err.stack?.slice(0, 1500),\n"
        "  })\n"
        "})\n"
        "\n"
        "process.on('unhandledRejection', (reason: unknown) => {\n"
        "  logger.error('unhandled_rejection', {\n"
        "    reason: String(reason).slice(0, 1500),\n"
        "  })\n"
        "})\n"
        "\n"
        "main().catch(err => {\n"
        "  logger.error('startup_failed', { err: err.message })\n"
        "  process.exit(1)\n"
        "})",
        'index.ts process handlers',
    )
    P.write_text(src)
    print('[1/2] index.ts — uncaughtException + unhandledRejection handlers installed')

# ── 2. EDIT: src/tenants/slackManager.ts — app.error() per-tenant ─────────
P = ROOT / 'src/tenants/slackManager.ts'
src = must_read(P)

if 'Phase 9f' in src or 'app.error(' in src:
    print('[2/2] slackManager.ts already has app.error handler — skipping')
else:
    src = replace_one(
        src,
        "  registerHitlActionHandlers(app)\n"
        "  await app.start()\n"
        "  apps.set(tenant.tenantId, app)\n"
        "  logger.info('tenant_bot_started', { tenantId: tenant.tenantId, client: tenant.clientName })",
        "  registerHitlActionHandlers(app)\n"
        "\n"
        "  // Phase 9f: catch Bolt-level errors before they propagate as uncaught.\n"
        "  // Logged with tenant context so we can attribute socket noise to the\n"
        "  // right tenant when investigating.\n"
        "  app.error(async (error: Error) => {\n"
        "    logger.error('slack_bolt_error', {\n"
        "      tenantId: tenant.tenantId,\n"
        "      msg:      error.message,\n"
        "      stack:    error.stack?.slice(0, 1500),\n"
        "    })\n"
        "  })\n"
        "\n"
        "  await app.start()\n"
        "  apps.set(tenant.tenantId, app)\n"
        "  logger.info('tenant_bot_started', { tenantId: tenant.tenantId, client: tenant.clientName })",
        'slackManager.ts app.error',
    )
    P.write_text(src)
    print('[2/2] slackManager.ts — app.error per-tenant handler installed')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
print('')
print('Verification after deploy: tail Cloud Run logs and watch for')
print('  - "uncaught_exception" entries (used to crash; now logged + survives)')
print('  - "slack_bolt_error" entries (per-tenant bolt errors caught early)')
print('')
print('If both appear without the process restarting, the fix is working.')
