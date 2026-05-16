#!/usr/bin/env python3
"""
phase9c-hotfix-patch.py — fix the circular import that broke the presenter.

THE BUG
=======
Phase 9c added `import { presenter } from '../../core/slack'` to
src/integrations/framer/executor.ts. That created a new module load chain
from src/index.ts:

  index.ts
    → tenants/slackManager.ts (mid-load)
      → hitl/index.ts
        → hitl/handlers.ts
          → hitl/execution-hook.ts
            → execution/dispatcher.ts
              → integrations/framer/executor.ts   (Phase 9c adds this line:)
                → core/slack/index.ts
                  → imports `apps` from tenants/slackManager
                    ← but slackManager hasn't finished loading yet
                    ← so `apps` is undefined here

core/slack/index.ts then runs `new SlackPresenter(apps, pool, logger)` with
apps=undefined. The singleton presenter is now permanently broken — every
call to this.apps.get(tenantId) crashes with:

  "Cannot read properties of undefined (reading 'get')"

THE FIX
=======
Move `apps` out of slackManager.ts into its own module
(tenants/apps-registry.ts). That module has no imports that cycle back
through slackManager, so it can be imported from anywhere safely.

Three changes:
  1. NEW src/tenants/apps-registry.ts
  2. EDIT src/tenants/slackManager.ts — remove local `apps` const, import from registry
  3. EDIT src/core/slack/index.ts — import apps from registry instead of slackManager

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

# ── 1. NEW: src/tenants/apps-registry.ts ────────────────────────────────────
P = ROOT / 'src/tenants/apps-registry.ts'
if P.exists() and 'apps-registry' in P.read_text():
    print('[1/3] apps-registry.ts already exists — skipping')
else:
    P.write_text(
        "// src/tenants/apps-registry.ts\n"
        "//\n"
        "// Module-level Map<tenantId, App> singleton. Lives in its own file —\n"
        "// NOT in slackManager.ts — so that core/slack/index.ts can import it\n"
        "// without creating a circular dependency.\n"
        "//\n"
        "// The cycle this exists to break:\n"
        "//   index → slackManager → hitl → execution → dispatcher\n"
        "//     → integrations/framer/executor (Phase 9c)\n"
        "//     → core/slack (imports apps)\n"
        "//     → back to slackManager (still mid-load → apps undefined)\n"
        "//\n"
        "// With `apps` in this leaf module, the cycle does not form.\n"
        "\n"
        "import type { App } from '@slack/bolt'\n"
        "\n"
        "export const apps = new Map<string, App>()\n"
    )
    print('[1/3] apps-registry.ts — created')

# ── 2. EDIT: src/tenants/slackManager.ts ────────────────────────────────────
P = ROOT / 'src/tenants/slackManager.ts'
src = must_read(P)
if "from './apps-registry'" in src:
    print('[2/3] slackManager.ts already imports from apps-registry — skipping')
else:
    # Replace the `export const apps = ...` line with an import from registry.
    # The actual line is "export const apps = new Map<string, App>()"
    src = replace_one(
        src,
        "export const apps = new Map<string, App>()",
        "// Phase 9c-fix: apps Map moved to its own module to break the circular\n"
        "// import that crashed the SlackPresenter. See apps-registry.ts for why.\n"
        "import { apps } from './apps-registry'\n"
        "export { apps }",
        'slackManager.ts apps declaration',
    )
    P.write_text(src)
    print('[2/3] slackManager.ts — imports apps from registry, re-exports for back-compat')

# ── 3. EDIT: src/core/slack/index.ts ────────────────────────────────────────
P = ROOT / 'src/core/slack/index.ts'
src = must_read(P)
if "from '../../tenants/apps-registry'" in src:
    print('[3/3] core/slack/index.ts already imports from apps-registry — skipping')
else:
    src = replace_one(
        src,
        "import { apps }   from '../../tenants/slackManager'",
        "// Phase 9c-fix: import apps from the leaf registry, not slackManager.\n"
        "// Going through slackManager creates a circular load via\n"
        "// hitl→execution→executor→core/slack which broke the presenter.\n"
        "import { apps }   from '../../tenants/apps-registry'",
        'core/slack/index.ts apps import',
    )
    P.write_text(src)
    print('[3/3] core/slack/index.ts — imports apps from registry')

print('\nDone. Verify:')
print('  npx tsc --noEmit')
print('  echo "exit: $?"')
print('')
print('If exit 0, commit + push:')
print('  git add -A')
print('  git commit -m "fix: break circular import that broke SlackPresenter')
print('')
print('Phase 9c added an import of presenter into framer/executor.ts, which')
print('created a circular load chain through hitl and execution that left')
print('apps undefined when core/slack/index.ts ran. SlackPresenter got')
print('apps=undefined and every presenter call crashed with')
print('\"Cannot read properties of undefined (reading get)\".')
print('')
print('Fix: move the apps Map out of slackManager.ts into a leaf module')
print('that the circular path does not cross."')
print('  git push')
