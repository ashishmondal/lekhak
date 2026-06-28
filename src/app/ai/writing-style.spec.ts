import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STYLE,
  MECHANICS,
  RULES,
  WRITING_STYLES,
  buildSystemPrompt,
  isWritingStyleId,
} from './writing-style';

describe('writing-style', () => {
  it('defaults to the screenwriter persona', () => {
    expect(DEFAULT_STYLE).toBe('screenwriter');
  });

  it('keeps the canon/contract mechanics in every style', () => {
    for (const style of WRITING_STYLES) {
      expect(buildSystemPrompt(style.id)).toContain(MECHANICS);
    }
  });

  it('appends the hard rules to the strict styles only', () => {
    expect(buildSystemPrompt('screenwriter')).toContain(RULES);
    expect(buildSystemPrompt('playwright')).toContain(RULES);
    expect(buildSystemPrompt('minimalist')).toContain(RULES);
    expect(buildSystemPrompt('cowriter')).not.toContain(RULES);
  });

  it('leads with the chosen persona', () => {
    expect(buildSystemPrompt('screenwriter')).toMatch(/^You are an award-winning screenwriter/);
    expect(buildSystemPrompt('cowriter')).toMatch(/^You are a co-writer/);
  });

  it('reproduces the original neutral prompt for cowriter', () => {
    expect(buildSystemPrompt('cowriter')).toBe(
      'You are a co-writer helping the author write a short story. ' + MECHANICS,
    );
  });

  it('falls back to the default style for an unknown id', () => {
    // @ts-expect-error exercising the runtime guard with a bad id
    expect(buildSystemPrompt('limerick')).toBe(buildSystemPrompt(DEFAULT_STYLE));
  });

  it('guards style ids', () => {
    expect(isWritingStyleId('playwright')).toBe(true);
    expect(isWritingStyleId('novelist')).toBe(false);
  });
});
