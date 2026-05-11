// src/scheduler/config.ts
//
// Default cron schedules applied to new tenants. Adjust per-tenant via
// upsertSchedule() if a tenant wants different timing.

export const DEFAULT_SCHEDULES = {
  daily: {
    cronExpr: '0 9 * * *',          // 9am every day
    timezone: 'Australia/Sydney',
  },
  weekly: {
    cronExpr: '0 8 * * 1',          // 8am Monday
    timezone: 'Australia/Sydney',
  },
} as const

/**
 * Convenience: register both default schedules for a tenant. Call this
 * the first time a tenant is onboarded.
 */
export async function applyDefaultSchedulesFor(tenantId: string): Promise<void> {
  const { upsertSchedule } = await import('./index')
  await upsertSchedule({
    tenantId,
    runKind: 'daily',
    cronExpr: DEFAULT_SCHEDULES.daily.cronExpr,
    timezone: DEFAULT_SCHEDULES.daily.timezone,
  })
  await upsertSchedule({
    tenantId,
    runKind: 'weekly',
    cronExpr: DEFAULT_SCHEDULES.weekly.cronExpr,
    timezone: DEFAULT_SCHEDULES.weekly.timezone,
  })
}
