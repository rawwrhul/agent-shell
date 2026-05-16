#!/usr/bin/env python3
"""
Fixup for chunk3-scheduler-mwf-patch.py — three TS errors after first run.

Errors fixed:
  1. TS2345 at line 60 — desired.has(j.id) when j.id can be null|undefined.
                          Adds an `if (!j.id) continue;` guard before the
                          pending-nudge skip.

  2. TS2339 at line 62 — `cron: j.cron` references a property that doesn't
                          exist on BullMQ's RepeatableJob type. The correct
                          field name is `pattern`.

  3. TS2304 at line 121 — `schedule.tenantId` referenced in a catch block
                          that got inlined into registerPendingNudgeScan
                          (which has no `schedule` parameter). Makes the
                          catch block generic — drops schedule.tenantId,
                          keeps jobId (which already encodes tenantId).

Root cause: chunk3's OLD_REGISTER pattern matched the
`await removeRepeatableByPattern(jobId, repeatOpts);` line in BOTH
registerRepeatable and registerPendingNudgeScan, so both got the
same replacement.

Idempotent: safe to run multiple times.

Usage:
  python3 chunk3-fixup.py
  npx tsc --noEmit && echo OK
"""
from pathlib import Path
import sys

P = Path('src/scheduler/index.ts')
if not P.exists():
    sys.exit(f"ERR: {P} not found — run from agent-shell-v3 repo root")

src = P.read_text()
orig = src

# ── Fix 1 + 2: reconcile loop in bootstrapSchedules ──────────────────

OLD_LOOP = """    for (const j of existing) {
      if (j.id === 'global:pending-nudge-scan') continue;
      if (!desired.has(j.id)) {
        await queue().removeRepeatableByKey(j.key);
        logger.info('schedule_orphan_removed', { jobId: j.id, cron: j.cron });
      }
    }"""

NEW_LOOP = """    for (const j of existing) {
      if (!j.id) continue;
      if (j.id === 'global:pending-nudge-scan') continue;
      if (!desired.has(j.id)) {
        await queue().removeRepeatableByKey(j.key);
        logger.info('schedule_orphan_removed', { jobId: j.id, pattern: j.pattern });
      }
    }"""

if OLD_LOOP in src:
    src = src.replace(OLD_LOOP, NEW_LOOP)
    print("[1+2] reconcile loop — added !j.id guard, j.cron → j.pattern")
elif NEW_LOOP in src:
    print("[1+2] reconcile loop already fixed (skipped)")
else:
    sys.exit("ERR: reconcile loop block not found — file may have been modified")


# ── Fix 3: generic catch block (works in both functions) ─────────────

OLD_CATCH = """  } catch (err) {
    logger.warn('register_remove_existing_failed', {
      tenantId: schedule.tenantId, jobId, err: String(err),
    });
  }"""

NEW_CATCH = """  } catch (err) {
    logger.warn('register_remove_existing_failed', {
      jobId, err: String(err),
    });
  }"""

count = src.count(OLD_CATCH)
if count > 0:
    src = src.replace(OLD_CATCH, NEW_CATCH)
    print(f"[3] catch block — fixed {count} occurrence(s), dropped schedule.tenantId")
elif NEW_CATCH in src and OLD_CATCH not in src:
    print("[3] catch block already fixed (skipped)")
else:
    sys.exit("ERR: catch block not found — file may have been modified")

if src != orig:
    P.write_text(src)

print()
print("Verify with:")
print("  npx tsc --noEmit && echo OK")
