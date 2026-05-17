// src/skills/seo-technical-auditor/checks/index.ts
//
// Registry of all checks the auditor runs. Order matters only for
// determinism in the run logs — findings are sorted by severity for output.

import type { Check } from '../types'
import { brokenInternalLinks } from './broken-internal-links'
import { orphanPages } from './orphan-pages'
import { missingMetaDescription } from './missing-meta-description'
import { missingH1 } from './missing-h1'
import { multipleH1 } from './multiple-h1'
import { canonicalConflicts } from './canonical-conflicts'
import { sitemapInconsistency } from './sitemap-inconsistency'
import { duplicateTitles } from './duplicate-titles'
import { duplicateMetaDescriptions } from './duplicate-meta-descriptions'

export const ALL_CHECKS: { name: string; fn: Check }[] = [
  { name: 'canonical_conflicts',         fn: canonicalConflicts        }, // P0-class first
  { name: 'duplicate_titles',            fn: duplicateTitles           },
  { name: 'broken_internal_links',       fn: brokenInternalLinks       },
  { name: 'sitemap_inconsistency',       fn: sitemapInconsistency      },
  { name: 'missing_meta_description',    fn: missingMetaDescription    },
  { name: 'missing_h1',                  fn: missingH1                 },
  { name: 'duplicate_meta_descriptions', fn: duplicateMetaDescriptions },
  { name: 'orphan_pages',                fn: orphanPages               },
  { name: 'multiple_h1',                 fn: multipleH1                },
]
