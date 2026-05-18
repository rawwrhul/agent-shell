// src/core/slack/blocks/shared.ts
//
// Pure helpers for Block Kit construction. Every render module composes
// from these so spacing, typography, and section structure stay consistent.
//
// R3.1: `normalizeSlackText` converts ChatGPT/Anthropic-style markdown
// (which the LLM emits naturally) into Slack mrkdwn, applied at the
// section/header boundary so all rendered text passes through one
// chokepoint:
//   [text](url)   → <url|text>
//   **bold**      → *bold*
//   __italic__    → _italic_

import type {
  KnownBlock,
  HeaderBlock,
  SectionBlock,
  ContextBlock,
  DividerBlock,
  ActionsBlock,
  Button,
  PlainTextElement,
  MrkdwnElement,
} from '@slack/web-api';

// ── Primitives ──────────────────────────────────────────────────────

export function header(text: string): HeaderBlock {
  // Slack truncates header text at 150 chars.
  // Header is plain_text, so strip markdown syntax rather than convert it.
  return {
    type: 'header',
    text: { type: 'plain_text', text: truncate(stripMarkdown(text), 150), emoji: true },
  };
}

export function divider(): DividerBlock {
  return { type: 'divider' };
}

/** Single mrkdwn paragraph. */
export function section(text: string): SectionBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: truncate(normalizeSlackText(text), 3000) },
  };
}

/**
 * Section block with a small caps "title" line followed by mrkdwn body.
 * Used for "SHIPPED OVERNIGHT" / "STATE OF PLAY" etc.
 */
export function titledSection(title: string, body: string): SectionBlock {
  return section(`*${title.toUpperCase()}*\n${body}`);
}

/**
 * Two-column field grid. Slack renders up to 10 fields in a 2-col layout.
 * Use for state-of-play scorecard.
 */
export function fieldsSection(fields: Array<{ label: string; value: string }>): SectionBlock {
  // Slack hard cap: 10 fields per section.
  const trimmed = fields.slice(0, 10);
  return {
    type: 'section',
    fields: trimmed.map(
      (f): MrkdwnElement => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${normalizeSlackText(f.value)}`,
      })
    ),
  };
}

/** Context block — used for footer-style "next run · workspace ↗" lines. */
export function context(parts: string[]): ContextBlock {
  // Slack cap: 10 elements per context block.
  return {
    type: 'context',
    elements: parts
      .slice(0, 10)
      .map((p): MrkdwnElement => ({ type: 'mrkdwn', text: normalizeSlackText(p) })),
  };
}

/** Action row of buttons (used for HITL approve/reject). */
export function actions(actionId: string, buttons: ButtonSpec[]): ActionsBlock {
  return {
    type: 'actions',
    block_id: actionId,
    elements: buttons.map(button),
  };
}

export interface ButtonSpec {
  actionId: string;
  text: string;
  value?: string;
  style?: 'primary' | 'danger';
  url?: string;
}

function button(spec: ButtonSpec): Button {
  const b: Button = {
    type: 'button',
    text: { type: 'plain_text', text: spec.text, emoji: true },
    action_id: spec.actionId,
  };
  if (spec.value) b.value = spec.value;
  if (spec.style) b.style = spec.style;
  if (spec.url) b.url = spec.url;
  return b;
}

// ── Composite list patterns ─────────────────────────────────────────
//
// Slack doesn't have a native "list" block. We render lists as a single
// mrkdwn section with each item on its own line. Keep items short — long
// items get truncated mid-line and look bad.

export interface ListItem {
  /** Leading icon — emoji shortcode or unicode glyph. */
  icon?: string;
  /** Primary line. */
  title: string;
  /** Secondary muted line — rendered as small grey text below. */
  detail?: string;
  /** Right-aligned meta — timestamp, ETA, priority. */
  meta?: string;
}

/**
 * Render a list of items as a mrkdwn section. Each item gets its own line,
 * with detail rendered as a continuation underneath. Used for shipped /
 * queued / opportunities lists.
 */
export function itemList(items: ListItem[]): SectionBlock {
  const lines = items.map((item) => {
    const icon = item.icon ?? '•';
    const meta = item.meta ? `  \`${item.meta}\`` : '';
    const main = `${icon} ${escape(item.title)}${meta}`;
    if (!item.detail) return main;
    return `${main}\n   _${escape(item.detail)}_`;
  });
  return section(lines.join('\n'));
}

/**
 * Numbered priority rows: `P0` / `P1` markers with body and right-aligned meta.
 * Used for "Top 3 leverage moves" in the weekly audit.
 */
export interface PriorityRow {
  rank: string;     // "P0" / "P1"
  title: string;
  detail?: string;
  meta?: string;    // "impact: high"
}

export function priorityList(rows: PriorityRow[]): SectionBlock {
  const lines = rows.map((row) => {
    const meta = row.meta ? `  \`${row.meta}\`` : '';
    const main = `\`${row.rank}\` *${escape(row.title)}*${meta}`;
    if (!row.detail) return main;
    return `${main}\n      _${escape(row.detail)}_`;
  });
  return section(lines.join('\n'));
}

// ── Status pill helpers ─────────────────────────────────────────────

export type PhaseStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export function phaseIcon(status: PhaseStatus): string {
  switch (status) {
    case 'pending':     return '◯';
    case 'in_progress': return '◐';
    case 'done':        return '●';
    case 'failed':      return '✕';
  }
}

// ── Formatting utilities ────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Escape Slack mrkdwn special characters that could break the layout. */
export function escape(s: string): string {
  return s.replace(/[<>&]/g, (c) => {
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    return '&amp;';
  });
}

/**
 * Convert common ChatGPT/Anthropic markdown to Slack mrkdwn.
 * Applied at the section/context/fields boundary so any LLM-emitted text
 * renders correctly regardless of which renderer produced it.
 *
 * Conversions:
 *   [text](url)   → <url|text>            (Slack link syntax)
 *   **bold**      → *bold*                (Slack uses single asterisk)
 *   __italic__    → _italic_              (Slack uses single underscore)
 *
 * Preserves:
 *   `inline code`, ```code blocks```, *single asterisk* (already valid),
 *   _single underscore_ (already valid), URLs already in Slack format.
 *
 * Idempotent — safe to call multiple times on the same string.
 */
export function normalizeSlackText(s: string): string {
  if (!s) return s;
  return s
    // Markdown links → Slack links. Skip if angle brackets already present
    // (already converted), and skip the rare case where url contains spaces
    // or parens by limiting url chars.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
    // Bold (double asterisk) → Slack bold (single asterisk).
    // Greedy non-asterisk match keeps simple cases right; nested ** is unusual.
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    // Italic (double underscore) → Slack italic (single underscore).
    .replace(/__([^_\n]+)__/g, '_$1_');
}

/**
 * Strip markdown syntax entirely. Used for header text (plain_text type
 * doesn't render mrkdwn, so we want clean text not markup characters).
 */
export function stripMarkdown(s: string): string {
  if (!s) return s;
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [text](url) → text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')        // **bold** → bold
    .replace(/__([^_\n]+)__/g, '$1')            // __italic__ → italic
    .replace(/\*([^*\n]+)\*/g, '$1')            // *emph* → emph
    .replace(/`([^`\n]+)`/g, '$1');             // `code` → code
}

// Defensive coercion: the LLM returns dates as JSON strings, not Date
// objects. TypeScript can't catch this at compile time because the
// types claim Date — so we coerce at the call site.
function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d)
}

export function formatTime(d: Date | string, tz = 'Australia/Sydney'): string {
  d = toDate(d)
  return new Intl.DateTimeFormat('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  }).format(d);
}

export function formatDate(d: Date | string, tz = 'Australia/Sydney'): string {
  d = toDate(d)
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: tz,
  }).format(d);
}

export function formatRelative(d: Date | string, now: Date = new Date()): string {
  d = toDate(d)
  if (Number.isNaN(d.getTime())) return 'recently'
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

/** "+12pt" / "−2.1" / "+3 vs last wk" — caller supplies the string. */
export function deltaSymbol(direction: 'up' | 'down' | 'flat'): string {
  if (direction === 'up') return '↗';
  if (direction === 'down') return '↘';
  return '·';
}

/** Build a fallback push-notification text from a header + summary. */
export function fallbackText(parts: { title: string; summary?: string }): string {
  if (parts.summary) return `${parts.title} — ${parts.summary}`;
  return parts.title;
}

// ── Block array helpers ─────────────────────────────────────────────

/** Drop falsy / empty values from a block list. Lets renderers conditionally
 *  emit blocks via expressions like `cond && section('…')`. The `cond` may be
 *  a string (which evaluates to `''` when empty), a boolean, a number, or
 *  null/undefined — all of those filter through. */
export type Falsy = false | null | undefined | '' | 0;

export function compact<T>(blocks: Array<T | Falsy>): T[] {
  return blocks.filter((b): b is T => Boolean(b));
}

/** Slack's block limit per message is 50. Truncate with a notice if over. */
export function capBlocks(blocks: KnownBlock[], maxBlocks = 50): KnownBlock[] {
  if (blocks.length <= maxBlocks) return blocks;
  const truncated = blocks.slice(0, maxBlocks - 1);
  truncated.push(context(['_Output truncated to fit Slack block limit. Full report in workspace._']));
  return truncated;
}
