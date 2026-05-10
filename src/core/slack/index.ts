// src/core/slack/index.ts
//
// Module-level singleton. The presenter holds a reference to the `apps` Map
// from slackManager — that Map starts empty and is populated as tenant bots
// boot up. The presenter looks up `apps.get(tenantId)` at call time, so it
// transparently sees bots added after construction.
//
// Anywhere in the codebase that needs to post to Slack, import from here:
//
//     import { presenter } from '../core/slack'
//     await presenter.startRun({ ... })
//
// Don't construct your own SlackPresenter — there is one per process.

import { apps }   from '../../tenants/slackManager'
import { pool }   from '../../memory/postgres'
import { logger } from '../../logger'
import { SlackPresenter } from './presenter'

export const presenter = new SlackPresenter(apps, pool, logger)

export { SlackPresenter } from './presenter'
export * from './types'
