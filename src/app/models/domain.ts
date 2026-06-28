/**
 * Domain model for lekhak. These shapes are the IndexedDB v1 record contracts
 * (see StorageService). Cards belong to a WORLD, not a story.
 */

import type { WritingStyleId } from '../ai/writing-style';

export interface Era {
  id: string;
  name: string;
  /** Display order only; era resolution does not depend on it. */
  order: number;
}

export interface World {
  id: string;
  title: string;
  eras: Era[];
  updatedAt: number;
}

export interface Story {
  id: string;
  worldId: string;
  /** The single era this story (and all its chapters) is anchored to. */
  eraId: string;
  title: string;
  /**
   * Writing persona, chosen at creation and locked for the story's life.
   * Optional only for pre-style records; resolve a missing value to the
   * default style.
   */
  styleId?: WritingStyleId;
  updatedAt: number;
}

export interface Chapter {
  id: string;
  storyId: string;
  order: number;
  title: string;
  body: string;
  updatedAt: number;
}

export type CardType = 'character' | 'place' | 'lore';

export type CardSource = 'manual' | 'extracted';

/** Per-era delta applied over a card's base fields at resolution time. */
export interface CardOverlay {
  name?: string;
  notes?: string;
}

export interface Card {
  id: string;
  worldId: string;
  type: CardType;
  name: string;
  notes: string;
  source: CardSource;
  aliases?: string[];
  /** Keyed by eraId. resolveCard merges the matching overlay over the base. */
  eraOverlays?: Record<string, CardOverlay>;
  updatedAt: number;
}
