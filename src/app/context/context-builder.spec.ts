import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { AiError } from '../ai/ai-error';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { FakeProvider } from '../ai/fake-provider';
import type { Card, Chapter, Story } from '../models/domain';
import {
  ContextBuilder,
  estimateTokens,
  fitBudget,
  resolveCard,
  selectRelevant,
} from './context-builder';

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'k1',
    worldId: 'w1',
    type: 'character',
    name: 'Mara',
    notes: 'Green eyes.',
    source: 'manual',
    updatedAt: 1,
    ...over,
  };
}
function chapter(over: Partial<Chapter> = {}): Chapter {
  return { id: 'c1', storyId: 's1', order: 0, title: '', body: '', updatedAt: 1, ...over };
}
function story(over: Partial<Story> = {}): Story {
  return { id: 's1', worldId: 'w1', eraId: 'e1', title: 'S', updatedAt: 1, ...over };
}

/** A body whose estimated token cost is exactly `tokens`. */
function bodyOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

describe('resolveCard', () => {
  it('returns the base card when there is no overlay for the era', () => {
    const c = card({ eraOverlays: { e2: { name: 'Old Mara' } } });
    expect(resolveCard(c, 'e1')).toBe(c);
  });

  it('merges a partial overlay over the base, falling back to base for omitted fields', () => {
    const c = card({ name: 'Mara', notes: 'Green eyes.', eraOverlays: { e2: { notes: 'Greyed, weary.' } } });
    const r = resolveCard(c, 'e2');
    expect(r.name).toBe('Mara'); // not overlaid → base
    expect(r.notes).toBe('Greyed, weary.'); // overlaid
  });

  it('applies overlaid name when present', () => {
    const c = card({ name: 'Mara', eraOverlays: { e2: { name: 'Queen Mara' } } });
    expect(resolveCard(c, 'e2').name).toBe('Queen Mara');
  });
});

describe('selectRelevant', () => {
  it('includes a card whose name appears in recent text', () => {
    const cards = [card({ id: 'k1', name: 'Mara' }), card({ id: 'k2', name: 'Brann' })];
    const out = selectRelevant(cards, 'and then Mara left');
    expect(out.map((c) => c.id)).toEqual(['k1']);
  });

  it('matches on an alias', () => {
    const cards = [card({ id: 'k1', name: 'Mara', aliases: ['the Witch'] })];
    expect(selectRelevant(cards, 'the witch appeared').map((c) => c.id)).toEqual(['k1']);
  });

  it('always includes pinned cards even with no textual hit', () => {
    const cards = [card({ id: 'k1', name: 'Mara' })];
    expect(selectRelevant(cards, 'nothing here', ['k1'])).toHaveLength(1);
  });

  it('excludes a card with no hit and no pin', () => {
    const cards = [card({ id: 'k1', name: 'Mara' })];
    expect(selectRelevant(cards, 'unrelated text')).toHaveLength(0);
  });

  it('an empty name never matches everything', () => {
    const cards = [card({ id: 'k1', name: '' })];
    expect(selectRelevant(cards, 'anything')).toHaveLength(0);
  });
});

describe('fitBudget', () => {
  it('keeps all chapters when they fit', () => {
    const chapters = [0, 1, 2].map((o) => chapter({ id: `c${o}`, order: o, body: bodyOfTokens(10) }));
    const r = fitBudget(chapters, 0, 1000);
    expect(r.keptChapters).toHaveLength(3);
    expect(r.trimmedNote).toBeNull();
    expect(r.droppedCount).toBe(0);
  });

  it('always keeps the current draft and the immediately prior chapter', () => {
    const chapters = [0, 1, 2, 3].map((o) => chapter({ id: `c${o}`, order: o, body: bodyOfTokens(50) }));
    // Budget only fits ~the two mandatory chapters.
    const r = fitBudget(chapters, 0, 100);
    const ids = r.keptChapters.map((c) => c.id);
    expect(ids).toContain('c3'); // current
    expect(ids).toContain('c2'); // prior
  });

  it('drops the oldest chapters first and names them in the notice', () => {
    const chapters = [0, 1, 2, 3].map((o) => chapter({ id: `c${o}`, order: o, body: bodyOfTokens(50) }));
    const r = fitBudget(chapters, 0, 100); // room for the two mandatory only
    expect(r.droppedCount).toBe(2);
    expect(r.keptChapters.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(r.trimmedNote).toBe('Chapters 1–2 trimmed to fit — bible and recent chapters intact');
  });

  it('uses the singular label when exactly one chapter is dropped', () => {
    const chapters = [0, 1, 2].map((o) => chapter({ id: `c${o}`, order: o, body: bodyOfTokens(50) }));
    const r = fitBudget(chapters, 0, 100); // fits c1+c2, drops c0
    expect(r.droppedCount).toBe(1);
    expect(r.trimmedNote).toBe('Chapter 1 trimmed to fit — bible and recent chapters intact');
  });
});

describe('ContextBuilder.build', () => {
  const builder = new ContextBuilder();

  it('resolves cards for the story era and includes only relevant ones', () => {
    const cards = [
      card({ id: 'k1', name: 'Mara', eraOverlays: { e2: { name: 'Queen Mara' } } }),
      card({ id: 'k2', name: 'Brann' }),
    ];
    const result = builder.build({
      story: story({ eraId: 'e2' }),
      chapters: [chapter({ order: 0, body: 'Queen Mara walked in.' })],
      cards,
    });
    expect(result.usedCards.map((c) => c.id)).toEqual(['k1']);
    expect(result.usedCards[0].name).toBe('Queen Mara'); // resolved for e2
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('## WORLD BIBLE');
    expect(result.messages[0].content).toContain('### Character: Queen Mara');
  });

  it('selects a card named in an earlier chapter even when the recent chapter only uses a pronoun', () => {
    const cards = [card({ id: 'k1', name: 'Mara' })];
    const chapters = [
      chapter({ id: 'c0', order: 0, body: 'Mara drew her sword at dawn.' }),
      chapter({ id: 'c1', order: 1, body: 'She pressed on through the dark.' }),
    ];
    const result = builder.build({ story: story(), chapters, cards });
    // The current chapter only says "She" — full-context scan still resolves Mara.
    expect(result.usedCards.map((c) => c.id)).toEqual(['k1']);
  });

  it('honors an explicit recentText override for the relevance scan', () => {
    const cards = [card({ id: 'k1', name: 'Mara' })];
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'Mara was here.' })],
      cards,
      recentText: 'nothing relevant',
    });
    expect(result.usedCards).toHaveLength(0);
  });

  it('omits the bible block when no cards are relevant', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'A quiet morning.' })],
      cards: [card({ id: 'k1', name: 'Mara' })],
    });
    expect(result.usedCards).toHaveLength(0);
    expect(result.messages[0].content).not.toContain('## WORLD BIBLE');
  });

  it('puts the next beat into the user message', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'She opened the door.' })],
      cards: [],
      nextBeat: 'a stranger steps out of the rain',
    });
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].content).toContain('She opened the door.');
    expect(result.messages[1].content).toContain('What happens next: a stranger steps out of the rain');
  });

  it('emits a rewrite instruction when a selection is given', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'It was a dark night.' })],
      cards: [],
      selection: 'It was a dark night.',
    });
    expect(result.messages[1].content).toContain('Rewrite the following passage');
  });

  it('propagates the trim notice from the budget pass', () => {
    const chapters = [0, 1, 2, 3].map((o) =>
      chapter({ id: `c${o}`, order: o, body: bodyOfTokens(50) }),
    );
    const result = builder.build({ story: story(), chapters, cards: [], tokenBudget: 110 });
    expect(result.trimmedNote).toContain('trimmed to fit');
  });

  it('appends the synopsis as a STORY SO FAR block before the bible', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'Mara lit the lamp.' })],
      cards: [card({ id: 'k1', name: 'Mara' })],
      synopsis: 'Earlier, Mara fled the capital.',
    });
    const system = result.messages[0].content;
    expect(system).toContain('## STORY SO FAR');
    expect(system).toContain('Earlier, Mara fled the capital.');
    // Order: STORY SO FAR appears before the WORLD BIBLE.
    expect(system.indexOf('## STORY SO FAR')).toBeLessThan(system.indexOf('## WORLD BIBLE'));
  });

  it('omits the synopsis block when none is provided', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'A quiet morning.' })],
      cards: [],
    });
    expect(result.messages[0].content).not.toContain('## STORY SO FAR');
  });

  it('takes the synopsis as input verbatim (builder stays pure)', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'x' })],
      cards: [],
      synopsis: 'Pre-computed summary.',
    });
    expect(result.messages[0].content).toContain('Pre-computed summary.');
  });

  it('truncates the synopsis and notes it when memory overflows the cap', () => {
    // A short base prompt makes the leftover/cap math predictable; a long
    // synopsis then overflows the room the cap allows.
    const longSynopsis = 'word '.repeat(400).trim();
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'A quiet morning.' })],
      cards: [],
      systemPrompt: 'S',
      synopsis: longSynopsis,
      tokenBudget: 120,
    });
    const system = result.messages[0].content;
    expect(system).toContain('## STORY SO FAR');
    expect(system).toContain('…'); // truncation marker
    expect(result.trimmedNote).toContain('Summary of earlier chapters truncated');
  });

  it('enabling a synopsis never drops a chapter that fit without one (monotonicity)', () => {
    const chapters = [0, 1, 2, 3].map((o) =>
      chapter({ id: `c${o}`, order: o, body: bodyOfTokens(40) }),
    );
    const base = {
      story: story(),
      chapters,
      cards: [],
      systemPrompt: 'S',
      tokenBudget: 130,
    };
    const without = builder.build(base);
    const withSyn = builder.build({ ...base, synopsis: 'word '.repeat(1000) });
    // The budget is tight enough that a chapter drops even without a synopsis…
    expect(without.droppedChapterIds.length).toBeGreaterThan(0);
    // …and adding a (large) synopsis must not drop any additional chapter.
    expect(withSyn.droppedChapterIds).toEqual(without.droppedChapterIds);
  });

  it('build is pure: it touches no AI provider, even with a synopsis to place', () => {
    // A provider that throws the instant it is drained. If build() ever called
    // it, this would throw; purity means it never does.
    const throwing = new FakeProvider({
      chunks: [],
      error: new AiError('network', 'must not be called'),
      errorAfter: 0,
    });
    TestBed.configureTestingModule({
      providers: [{ provide: AI_PROVIDER, useValue: throwing }, ContextBuilder],
    });
    const injected = TestBed.inject(ContextBuilder);
    const result = injected.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'Mara.' })],
      cards: [card({ id: 'k1', name: 'Mara' })],
      synopsis: 'Earlier events.',
    });
    expect(result.messages[0].content).toContain('Earlier events.');
  });

  it('uses the style system prompt when one is supplied', () => {
    const result = builder.build({
      story: story(),
      chapters: [chapter({ order: 0, body: 'A quiet morning.' })],
      cards: [],
      systemPrompt: 'CUSTOM STYLE PROMPT',
    });
    expect(result.messages[0].content).toContain('CUSTOM STYLE PROMPT');
  });
});

describe('estimateTokens', () => {
  it('uses the chars/4 heuristic', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
