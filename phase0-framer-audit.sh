#!/usr/bin/env bash
# phase0-framer-audit.sh
#
# Audits the framer-api SDK's actual surface (via its .d.ts files) and writes
# a structured report to docs/framer-capabilities.md.
#
# Run from the agent-shell-v3 project root.

set -euo pipefail

PKG_DIR="node_modules/framer-api"
OUT="docs/framer-capabilities.md"

# --- 0. Locate the package -----------------------------------------------------
if [ ! -d "$PKG_DIR" ]; then
  echo "ERROR: $PKG_DIR not found. Are you in the project root?" >&2
  echo "" >&2
  echo "Framer-related packages installed:" >&2
  find node_modules -maxdepth 3 -name package.json \
    -exec grep -l '"name":[^,]*framer' {} \; 2>/dev/null \
    | sed 's|/package.json||' >&2
  echo "" >&2
  echo "If the real package isn't 'framer-api', edit PKG_DIR at the top of this script." >&2
  exit 1
fi

DTS_FILES=$(find "$PKG_DIR" -name "*.d.ts" -not -path "*/node_modules/*")
if [ -z "$DTS_FILES" ]; then
  echo "ERROR: no .d.ts files in $PKG_DIR. Package may be JS-only or types live elsewhere." >&2
  echo "Files in $PKG_DIR:" >&2
  ls -la "$PKG_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
VERSION=$(node -p "require('./$PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")

# --- 1. Generate the report ----------------------------------------------------
{
  echo "# Framer API Capabilities Audit"
  echo
  echo "- Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- Package: \`framer-api\` @ ${VERSION}"
  echo "- .d.ts files scanned:"
  for f in $DTS_FILES; do echo "  - \`$f\`"; done
  echo
  echo "> Some greps below are intentionally broad — false positives are fine, misses aren't."
  echo

  echo "## Top-level exports and declarations"
  echo
  echo '```typescript'
  grep -hnE "^export|^declare (class|function|interface|type|const|enum)" $DTS_FILES \
    | head -100 || true
  echo '```'
  echo

  echo "## References to a \`framer\` client instance"
  echo
  echo '```typescript'
  grep -hnE "framer\." $DTS_FILES | head -60 || true
  echo '```'
  echo

  echo "## WebPageNode class body"
  echo
  echo '```typescript'
  for f in $DTS_FILES; do
    sed -n '/declare class WebPageNode/,/^}/p' "$f"
  done
  echo '```'
  echo

  echo "## TextNode class body"
  echo
  echo '```typescript'
  for f in $DTS_FILES; do
    sed -n '/declare class TextNode/,/^}/p' "$f"
  done
  echo '```'
  echo

  echo "## CMS-related symbols"
  echo
  echo '```typescript'
  grep -hnE "addItems|createCollection|getCollections|getItems|CollectionNode|CollectionItem|Collection\b" $DTS_FILES \
    | head -50 || true
  echo '```'
  echo

  echo "## Publish / deploy / preview"
  echo
  echo '```typescript'
  grep -hnE "\b(publish|deploy|getChangedPaths|preview)\b" $DTS_FILES | head -30 || true
  echo '```'
  echo

  echo "## SEO / meta fields"
  echo
  echo '```typescript'
  grep -hnE "seo|metaTitle|metaDescription|ogImage|canonical|robots|openGraph" $DTS_FILES \
    | head -30 || true
  echo '```'
  echo

  echo "## URL / path / slug controls"
  echo
  echo '```typescript'
  grep -hnE "\b(setPath|slug|pathSegment|urlPath|path:)\b" $DTS_FILES | head -30 || true
  echo '```'
  echo

  echo "## connect / disconnect signatures"
  echo
  echo '```typescript'
  grep -hnE -B 0 -A 3 "function (connect|disconnect)" $DTS_FILES || true
  echo '```'
  echo

  echo "## Questions to answer from the output above"
  echo
  echo "- [ ] **Clone a page** — method name and full signature:"
  echo "- [ ] **Set text content** on an existing node — method and signature:"
  echo "- [ ] **Create a CMS item** — method, required fields, optional fields:"
  echo "- [ ] **Set URL path / slug** on a new page or CMS item:"
  echo "- [ ] **Set SEO meta** on a CMS item (even if page-level is unavailable):"
  echo "- [ ] **Publish** — does preview vs production exist? What triggers each?"
  echo

  echo "## Path decision (Phase 1 commit — one box only)"
  echo
  echo "- [ ] **A** — CMS-driven articles (requires \`addItems\` with title/slug/body/meta)"
  echo "- [ ] **B** — Clone template page + mutate text + publish"
  echo "- [ ] **C** — Research + recommendation only (gaps too large to publish via API)"
  echo
  echo "Rationale (one paragraph):"
  echo
} > "$OUT"

echo "✓ Audit written to $OUT"
echo
echo "Next:"
echo "  1. open $OUT"
echo "  2. fill in the question checkboxes from the dumped output"
echo "  3. tick exactly one path (A/B/C) with a one-paragraph rationale"
echo "  4. commit the file before writing any wrapper code"
