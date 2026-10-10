import { describe, it, expect } from 'vitest';
import { parseTimeExpression } from '@/search/timeparse';

// Fixed reference point: 15 Oct 2026, 14:00 local. All assertions are relative
// to this, never to wall-clock (AGENT.md — deterministic tests).
const NOW = new Date(2026, 9, 15, 14, 0, 0);

describe('parseTimeExpression', () => {
  it('resolves "last month" to the previous calendar month', () => {
    const { range, matched } = parseTimeExpression('computer architecture notes last month', NOW);

    expect(matched).toBe('last month');
    expect(range.from).toEqual(new Date(2026, 8, 1));
    expect(range.to).toEqual(new Date(2026, 9, 1));
  });

  it('resolves "last month" across a year boundary', () => {
    const jan = new Date(2026, 0, 10);
    const { range } = parseTimeExpression('notes last month', jan);

    expect(range.from).toEqual(new Date(2025, 11, 1));
    expect(range.to).toEqual(new Date(2026, 0, 1));
  });

  it('resolves "last N days"', () => {
    const { range } = parseTimeExpression('slides from the last 7 days', NOW);
    expect(range.from).toEqual(new Date(2026, 9, 8));
    expect(range.to).toEqual(new Date(2026, 9, 15));
  });

  it('resolves "last N weeks"', () => {
    const { range } = parseTimeExpression('diagrams last 2 weeks', NOW);
    expect(range.from).toEqual(new Date(2026, 9, 1));
  });

  it('resolves a bare month name to its most recent occurrence', () => {
    // "september" with now = October means Sept of this year, not next year.
    const { range } = parseTimeExpression('os notes in september', NOW);
    expect(range.from).toEqual(new Date(2026, 8, 1));
    expect(range.to).toEqual(new Date(2026, 9, 1));
  });

  it('resolves a future month name to the previous year', () => {
    const { range } = parseTimeExpression('notes in december', NOW);
    expect(range.from).toEqual(new Date(2025, 11, 1));
  });

  it('resolves "today" and "yesterday"', () => {
    expect(parseTimeExpression('what did I screenshot today', NOW).range.from)
      .toEqual(new Date(2026, 9, 15));
    expect(parseTimeExpression('yesterday', NOW).range.from)
      .toEqual(new Date(2026, 9, 14));
  });

  it('strips the time expression from the remaining query', () => {
    const { remainingQuery } = parseTimeExpression('computer architecture notes last month', NOW);
    expect(remainingQuery).toBe('computer architecture notes');
    expect(remainingQuery).not.toMatch(/month/i);
  });

  it('defaults to all-time when no expression matches', () => {
    const { range, matched } = parseTimeExpression('paging and TLB', NOW);
    expect(matched).toBeNull();
    expect(range.label).toBe('all time');
    expect(range.from.getTime()).toBe(0);
  });

  it('produces a human-readable label for every expression (F6)', () => {
    const queries = ['last month', 'this month', 'last week', 'today', 'yesterday', 'last 7 days', 'in october'];
    for (const q of queries) {
      const { range } = parseTimeExpression(q, NOW);
      expect(range.label.length).toBeGreaterThan(0);
      expect(range.label).not.toBe('Invalid Date');
    }
  });

  it('prefers the longest match: "last month" beats a bare month name', () => {
    const { matched } = parseTimeExpression('notes last month', NOW);
    expect(matched).toBe('last month');
  });

  it('returns a strictly increasing range for every expression', () => {
    const queries = ['last month', 'this month', 'last week', 'today', 'last 7 days', 'last 2 weeks', 'in october'];
    for (const q of queries) {
      const { range } = parseTimeExpression(q, NOW);
      expect(range.from.getTime()).toBeLessThan(range.to.getTime());
    }
  });
});