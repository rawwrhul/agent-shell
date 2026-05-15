#!/usr/bin/env python3
"""
phase8_6-patch.py — one-line image field fix.

Framer's writeable image field type expects (null | string) — just the URL.
Phase 7 wrote it as { url: imageUrl } which is the READ-side hydrated shape.
"""
from pathlib import Path
import sys

ROOT = Path.cwd()
P = ROOT / 'src/integrations/framer/client.ts'
src = P.read_text()

old = "fieldData[imageId] = { type: 'image', value: { url: post.imageUrl } }"
new = "fieldData[imageId] = { type: 'image', value: post.imageUrl }"

if new in src:
    print('already fixed — skipping')
elif old not in src:
    sys.exit(f'fatal: anchor not found in client.ts:\n{old}')
else:
    src = src.replace(old, new)
    P.write_text(src)
    print('fixed image field write format')

print('Run: npx tsc --noEmit')
