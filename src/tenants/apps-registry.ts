// src/tenants/apps-registry.ts
//
// Module-level Map<tenantId, App> singleton. Lives in its own file —
// NOT in slackManager.ts — so that core/slack/index.ts can import it
// without creating a circular dependency.
//
// The cycle this exists to break:
//   index → slackManager → hitl → execution → dispatcher
//     → integrations/framer/executor (Phase 9c)
//     → core/slack (imports apps)
//     → back to slackManager (still mid-load → apps undefined)
//
// With `apps` in this leaf module, the cycle does not form.

import type { App } from '@slack/bolt'

export const apps = new Map<string, App>()
