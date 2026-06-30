/**
 * Domain model for lekhak. These shapes are the IndexedDB v1 record contracts
 * (see StorageService). Cards belong to a WORLD, not a story.
 */

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
  /**
   * Extraction name-suggestions the author rejected, lowercased. World-scoped
   * (cards belong to a world, not a story) so a rejected name never re-nags
   * across the world's stories. Schemaless add — no DB version bump.
   */
  dismissedNames?: string[];
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
  styleId?: string;
  /**
   * Rolling summary of chapters that have been trimmed out of the live budget,
   * computed lazily in the background (see SynopsisService). Optional: absent
   * until the first trim happens. Schemaless add — no IndexedDB version bump.
   */
  synopsis?: string;
  /** When {@link synopsis} was last regenerated; drives coalescing of edits. */
  synopsisUpdatedAt?: number;
  /**
   * Drift flags the author dismissed for this story, by flag id. Story-scoped
   * because drift is judged against this draft. Schemaless add — no DB bump.
   */
  dismissedDriftIds?: string[];
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
