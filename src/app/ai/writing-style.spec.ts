import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STYLE,
  MECHANICS,
  RULES,
  WRITING_STYLES,
  buildSystemPrompt,
  isWritingStyleId,
  type CustomWritingStyle,
} from './writing-style';

describe('writing-style', () => {
  it('defaults to the banter persona', () => {
    expect(DEFAULT_STYLE).toBe('banter');
  });

  it('keeps the canon/contract mechanics in every style', () => {
    for (const style of WRITING_STYLES) {
      expect(buildSystemPrompt(style.id)).toContain(MECHANICS);
    }
  });

  it('appends the hard rules to every style', () => {
    for (const style of WRITING_STYLES) {
      expect(buildSystemPrompt(style.id)).toContain(RULES);
    }
  });

  it('leads with the chosen persona', () => {
    expect(buildSystemPrompt('banter')).toMatch(
      /^You are a contemporary fiction writer who specializes in witty/,
    );
    expect(buildSystemPrompt('repartee')).toMatch(
      /^You are a contemporary fiction writer who specializes in sharp/,
    );
  });

  it('offers the four dialogue-driven styles', () => {
    expect(WRITING_STYLES.map((s) => s.id)).toEqual([
      'banter',
      'romance',
      'repartee',
      'heartfelt',
    ]);
  });

  it('falls back to the default style for an unknown id', () => {
    expect(buildSystemPrompt('limerick')).toBe(buildSystemPrompt(DEFAULT_STYLE));
  });

  it('builds a prompt from a custom persona id when provided', () => {
    const custom: CustomWritingStyle = {
      id: 'custom-noir',
      label: 'Noir Detective',
      description: 'Hard-boiled voice and tension.',
      persona: 'You are a noir fiction writer with clipped atmospheric prose.',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(buildSystemPrompt(custom.id, [custom])).toContain(custom.persona);
    expect(buildSystemPrompt(custom.id, [custom])).toContain(MECHANICS);
  });

  it('guards style ids', () => {
    expect(isWritingStyleId('romance')).toBe(true);
    expect(isWritingStyleId('novelist')).toBe(false);
  });
});
