import { describe, expect, it } from 'vitest';

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
});

describe('estimateTokens', () => {
  it('uses the chars/4 heuristic', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
