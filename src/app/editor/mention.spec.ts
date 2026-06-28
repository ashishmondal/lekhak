import { describe, expect, it } from 'vitest';

import type { Card } from '../models/domain';
import { findActiveMention, rankCharacters } from './mention';

function card(partial: Partial<Card> & { name: string }): Card {
  return {
    id: partial.name.toLowerCase(),
    worldId: 'w1',
    type: 'character',
    notes: '',
    source: 'manual',
    updatedAt: 0,
    ...partial,
  };
}

describe('findActiveMention', () => {
  it('detects a mention at the start of the text', () => {
    expect(findActiveMention('@ann', 4)).toEqual({
      query: 'ann',
      start: 0,
      end: 4,
    });
  });

  it('detects a mention after whitespace', () => {
    expect(findActiveMention('she met @ar', 11)).toEqual({
      query: 'ar',
      start: 8,
      end: 11,
    });
  });

  it('opens on a bare @ with an empty query', () => {
    expect(findActiveMention('hello @', 7)).toEqual({
      query: '',
      start: 6,
      end: 7,
    });
  });

  it('ignores @ embedded in a word (e.g. emails)', () => {
    expect(findActiveMention('mail a@b', 8)).toBeNull();
  });

  it('closes once whitespace follows the @', () => {
    expect(findActiveMention('@ann smith', 10)).toBeNull();
  });

  it('only considers text up to the caret', () => {
    expect(findActiveMention('@annabel', 4)).toEqual({
      query: 'ann',
      start: 0,
      end: 4,
    });
  });

  it('returns null when there is no @', () => {
    expect(findActiveMention('plain text', 10)).toBeNull();
  });
});

describe('rankCharacters', () => {
  const roster: Card[] = [
    card({ name: 'Arna', aliases: ['the Witch'] }),
    card({ name: 'Aric' }),
    card({ name: 'Borin' }),
    card({ name: 'Mara', aliases: ['Ari'] }),
    card({ name: 'Tower', type: 'place' }),
  ];

  it('lists every character alphabetically for an empty query', () => {
    expect(rankCharacters(roster, '').map((c) => c.name)).toEqual([
      'Aric',
      'Arna',
      'Borin',
      'Mara',
    ]);
  });

  it('excludes non-character cards', () => {
    expect(rankCharacters(roster, '').some((c) => c.name === 'Tower')).toBe(
      false,
    );
  });

  it('ranks name prefixes above alias matches', () => {
    // "ari": Aric is a name prefix (score 3); Mara matches via alias "Ari" (2).
    expect(rankCharacters(roster, 'ari').map((c) => c.name)).toEqual([
      'Aric',
      'Mara',
    ]);
  });

  it('matches aliases case-insensitively', () => {
    expect(rankCharacters(roster, 'witch').map((c) => c.name)).toEqual(['Arna']);
  });

  it('respects the limit', () => {
    expect(rankCharacters(roster, '', 2)).toHaveLength(2);
  });
});
