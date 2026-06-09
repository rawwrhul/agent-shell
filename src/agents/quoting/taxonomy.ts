// src/agents/quoting/taxonomy.ts
//
// Curated Level 2 ASP job taxonomy (build requirements §8). The model does
// NOT freestyle categories — it classifies into this fixed set. This is the
// same classification muscle as the ServiceM8 LLM classifier; keep the two
// in sync (single source of truth lives here for the quoting agent).
//
// The electrician confirms/extends this set; treat it as a seeded config
// the way the rate card is seeded config.

export const QUOTING_TAXONOMY = {
  'Service & Connections': [
    'new connection (overhead)',
    'new connection (underground)',
    'service mains repair',
    'point-of-attachment repair',
    'UGOH conversion',
    'disconnect/reconnect',
  ],
  'Metering': [
    'new meter install',
    'meter relocation',
    'additional meter',
    'controlled-load/off-peak meter',
    'smart-meter exchange',
    'meter panel upgrade',
  ],
  'Switchboard': [
    'switchboard upgrade',
    'switchboard relocation',
    'fuse-to-RCBO upgrade',
    'board defect rectification',
  ],
  'Consumer Mains': [
    'consumer-mains upgrade',
    'consumer-mains repair',
    'phase upgrade (single→three)',
  ],
  'Poles & Infrastructure': [
    'private pole install',
    'private pole replacement',
    'temporary builders supply (TBS)',
  ],
  'Defects & Compliance': [
    'defect-notice rectification',
    'compliance inspection / CCEW-only',
  ],
} as const

export type Category = keyof typeof QUOTING_TAXONOMY
export type Subcategory = (typeof QUOTING_TAXONOMY)[Category][number]

export const CATEGORIES = Object.keys(QUOTING_TAXONOMY) as Category[]

/** Flat list of every subcategory across all categories. */
export const SUBCATEGORIES: string[] = Object.values(QUOTING_TAXONOMY).flatMap(
  (subs) => subs as readonly string[],
)

/** Stable registry key for a (category, subcategory) pair — used by the
 *  checklist/upsell registry (Chunk 3) and pricing cells (Chunk 4).
 *  e.g. categoryKey('Switchboard','switchboard upgrade')
 *       === 'switchboard:switchboard-upgrade' */
export function categoryKey(category: string, subcategory: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[()/]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
  return `${slug(category)}:${slug(subcategory)}`
}

/** True if the pair exists in the curated taxonomy. */
export function isKnownPair(category: string, subcategory: string): boolean {
  const subs = (QUOTING_TAXONOMY as Record<string, readonly string[]>)[category]
  return Array.isArray(subs) && subs.includes(subcategory)
}

/** Compact, prompt-ready rendering of the taxonomy for the Stage 1
 *  classifier prompt. Keeps the model anchored to the curated set. */
export function taxonomyForPrompt(): string {
  return CATEGORIES.map((cat) => {
    const subs = (QUOTING_TAXONOMY[cat] as readonly string[]).join(', ')
    return `- ${cat}: ${subs}`
  }).join('\n')
}
