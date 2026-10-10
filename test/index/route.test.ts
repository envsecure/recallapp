import { describe, it, expect } from 'vitest';
import {
  decideVision,
  VISION_CONFIDENCE_THRESHOLD,
  VISION_MIN_CHARS,
} from '@/index/route';
import type { ExtractedText } from '@/interfaces/capabilities';

function makeExtraction(text: string, confidence: number): ExtractedText {
  return {
    text,
    words: [],
    confidence,
    imageSize: { width: 100, height: 100 },
  };
}

describe('decideVision', () => {
  it('exposes default thresholds', () => {
    expect(VISION_CONFIDENCE_THRESHOLD).toBe(0.35);
    expect(VISION_MIN_CHARS).toBe(20);
  });

  it('empty extraction routes to vision', () => {
    const extracted = makeExtraction('', 0.99);
    expect(decideVision(extracted)).toBe(true);
  });

  it('whitespace-only extraction routes to vision', () => {
    const extracted = makeExtraction('   ', 0.99);
    expect(decideVision(extracted)).toBe(true);
  });

  it('high-confidence dense text does NOT route to vision', () => {
    const extracted = makeExtraction(
      'This is a dense slide with plenty of text content for indexing.',
      0.95,
    );
    expect(decideVision(extracted)).toBe(false);
  });

  it('low confidence routes to vision even with dense text', () => {
    const extracted = makeExtraction(
      'This is a dense slide with plenty of text content for indexing.',
      0.1,
    );
    expect(decideVision(extracted)).toBe(true);
  });

  it('short text routes to vision even with high confidence', () => {
    const extracted = makeExtraction('hi', 0.99);
    expect(decideVision(extracted)).toBe(true);
  });

  it('honours custom thresholds', () => {
    const extracted = makeExtraction('0123456789abcdef', 0.5);
    expect(
      decideVision(extracted, { confidenceThreshold: 0.9, minChars: 5 }),
    ).toBe(true);
    expect(
      decideVision(extracted, { confidenceThreshold: 0.1, minChars: 5 }),
    ).toBe(false);
  });
});
