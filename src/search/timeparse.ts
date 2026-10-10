/**
 * Resolve a time expression from a query into a concrete range.
 *
 * The whole point is that the result is *shown to the user* (F6). "last month"
 * is genuinely ambiguous — it can mean the previous calendar month or the last
 * 30 days — so we pick one, label it, and let the user correct it in a click.
 * Guessing silently is what makes temporal search feel broken.
 *
 * Pure functions over an injected `now`, so tests are deterministic (AGENT.md).
 */

import type { TimeRange } from '@/interfaces/capabilities';

export interface ParsedTime {
  /** The range. */
  range: TimeRange;
  /** Query text with the time expression removed, for embedding. */
  remainingQuery: string;
  /** Which expression matched, for display. */
  matched: string | null;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function fmt(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Time expressions, longest-first so "last week" wins over a bare "last".
 */
const PATTERNS: {
  name: string;
  re: RegExp;
  resolve: (m: RegExpExecArray, now: Date) => TimeRange;
}[] = [
  {
    name: 'last month',
    re: /\blast\s+month\b/i,
    resolve: (_m, now) => {
      // Previous calendar month, not "the last 30 days". Deliberate choice:
      // students say "last month" meaning "the month before this one".
      const firstOfThis = startOfMonth(now);
      const to = firstOfThis;
      const from = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      return { from, to, label: `${fmt(from)} – ${fmt(new Date(to.getTime() - 1))}` };
    },
  },
  {
    name: 'this month',
    re: /\bthis\s+month\b/i,
    resolve: (_m, now) => ({
      from: startOfMonth(now),
      to: endOfMonth(now),
      label: `${fmt(startOfMonth(now))} – ${fmt(new Date(endOfMonth(now).getTime() - 1))}`,
    }),
  },
  {
    name: 'last week',
    re: /\blast\s+week\b/i,
    resolve: (_m, now) => {
      const to = startOfDay(now);
      const from = addDays(to, -7);
      return { from, to, label: `${fmt(from)} – ${fmt(addDays(to, -1))}` };
    },
  },
  {
    name: 'today',
    re: /\b(today|just\s+now)\b/i,
    resolve: (_m, now) => ({
      from: startOfDay(now),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
      label: 'today',
    }),
  },
  {
    name: 'yesterday',
    re: /\byesterday\b/i,
    resolve: (_m, now) => {
      const to = startOfDay(now);
      return { from: addDays(to, -1), to, label: fmt(addDays(to, -1)) };
    },
  },
  {
    name: 'last N days',
    re: /\blast\s+(\d{1,3})\s+days?\b/i,
    resolve: (m, now) => {
      const n = Number(m[1]);
      const to = startOfDay(now);
      const from = addDays(to, -n);
      return { from, to, label: `last ${n} days (${fmt(from)} – ${fmt(addDays(to, -1))})` };
    },
  },
  {
    name: 'last N weeks',
    re: /\blast\s+(\d{1,2})\s+weeks?\b/i,
    resolve: (m, now) => {
      const n = Number(m[1]);
      const to = startOfDay(now);
      const from = addDays(to, -7 * n);
      return { from, to, label: `last ${n} weeks (${fmt(from)} – ${fmt(addDays(to, -1))})` };
    },
  },
  {
    name: 'in <month>',
    re: new RegExp(`\\b(?:in\\s+)?(${MONTHS.join('|')})\\b`, 'i'),
    resolve: (m, now) => {
      const idx = MONTHS.indexOf((m[1] ?? '').toLowerCase());
      if (idx < 0) {
        // Unreachable given the regex only matches MONTHS, but returning the
        // all-time range beats letting a bad index build an Invalid Date.
        return { from: new Date(0), to: new Date(now.getTime() + 86_400_000), label: 'all time' };
      }
      // A bare month name with no year means the most recent occurrence.
      let year = now.getFullYear();
      let from = new Date(year, idx, 1);
      if (from.getTime() > now.getTime()) {
        year -= 1;
        from = new Date(year, idx, 1);
      }
      const to = new Date(year, idx + 1, 1);
      return { from, to, label: `${fmt(from)} – ${fmt(new Date(to.getTime() - 1))} ${year}` };
    },
  },
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Parse the first matching time expression out of `query`.
 *
 * Returns a default "all time" range when nothing matches, so callers never
 * need a null branch. The range is wide rather than wrong.
 */
export function parseTimeExpression(query: string, now: Date): ParsedTime {
  for (const p of PATTERNS) {
    const m = p.re.exec(query);
    if (!m) continue;
    return {
      range: p.resolve(m, now),
      remainingQuery: query.replace(m[0], ' ').replace(/\s+/g, ' ').trim(),
      matched: m[0].trim(),
    };
  }
  return {
    range: { from: new Date(0), to: new Date(now.getTime() + 86_400_000), label: 'all time' },
    remainingQuery: query.trim(),
    matched: null,
  };
}