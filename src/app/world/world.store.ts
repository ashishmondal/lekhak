import { Service, computed, inject, signal } from '@angular/core';

import type {
  Card,
  CardOverlay,
  CardSource,
  CardType,
  Era,
  Story,
  World,
} from '../models/domain';
import { StorageService } from '../services/storage.service';

/** The single implicit world's id in v1 (no world switcher yet). */
export const DEFAULT_WORLD_ID = 'world-1';
const DEFAULT_WORLD_TITLE = 'My World';
const DEFAULT_ERA_NAME = 'Present day';

/** Result of a guarded delete: blocked deletes carry a named reason. */
export type DeleteResult = { ok: true } | { ok: false; reason: string };

export interface NewCard {
  type: CardType;
  name: string;
  notes: string;
  aliases?: string[];
  /** Provenance; defaults to 'manual'. Extraction-accept passes 'extracted'. */
  source?: CardSource;
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Owns the single implicit world: its eras and its cards. Referential integrity
 * lives here because IndexedDB has no foreign keys — an era in use by a story
 * cannot be deleted, and the last era cannot be removed. State is exposed as
 * signals so the editor and world panel stay in sync.
 */
@Service()
export class WorldStore {
  private readonly storage = inject(StorageService);

  readonly world = signal<World | null>(null);
  readonly cards = signal<Card[]>([]);
  /** Era used for resolution preview and as the new-story anchor. */
  readonly currentEraId = signal<string>('');
  readonly ready = signal(false);

  readonly eras = computed<Era[]>(() =>
    [...(this.world()?.eras ?? [])].sort((a, b) => a.order - b.order),
  );

  /** Load the world (bootstrapping a default one on first run) and its cards. */
  async init(): Promise<void> {
    if (this.ready()) {
      return;
    }
    let world = await this.storage.getWorld(DEFAULT_WORLD_ID);
    if (!world) {
      world = {
        id: DEFAULT_WORLD_ID,
        title: DEFAULT_WORLD_TITLE,
        eras: [{ id: uuid(), name: DEFAULT_ERA_NAME, order: 0 }],
        updatedAt: Date.now(),
      };
      await this.storage.putWorld(world);
    }
    this.world.set(world);
    this.cards.set(await this.storage.getCardsByWorld(world.id));
    this.currentEraId.set(world.eras[0]?.id ?? '');
    this.ready.set(true);
  }

  setCurrentEra(eraId: string): void {
    this.currentEraId.set(eraId);
  }

  // --- eras ---------------------------------------------------------------

  async addEra(name: string): Promise<void> {
    const world = this.world();
    if (!world) {
      return;
    }
    const order = world.eras.reduce((max, e) => Math.max(max, e.order), -1) + 1;
    const era: Era = { id: uuid(), name: name.trim() || 'Untitled era', order };
    await this.saveWorld({ ...world, eras: [...world.eras, era] });
  }

  async renameEra(id: string, name: string): Promise<void> {
    const world = this.world();
    if (!world) {
      return;
    }
    const eras = world.eras.map((e) =>
      e.id === id ? { ...e, name: name.trim() || e.name } : e,
    );
    await this.saveWorld({ ...world, eras });
  }

  /** Move an era one slot earlier (-1) or later (+1) by swapping order. */
  async moveEra(id: string, direction: -1 | 1): Promise<void> {
    const world = this.world();
    if (!world) {
      return;
    }
    const ordered = [...world.eras].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((e) => e.id === id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= ordered.length) {
      return;
    }
    const a = ordered[index];
    const b = ordered[swapWith];
    const eras = world.eras.map((e) => {
      if (e.id === a.id) return { ...e, order: b.order };
      if (e.id === b.id) return { ...e, order: a.order };
      return e;
    });
    await this.saveWorld({ ...world, eras });
  }

  /**
   * Delete an era. Blocked if any story is anchored to it, or if it is the last
   * era. On success, orphaned per-era overlays are stripped from all cards.
   */
  async deleteEra(id: string): Promise<DeleteResult> {
    const world = this.world();
    if (!world) {
      return { ok: false, reason: 'No world loaded.' };
    }
    if (world.eras.length <= 1) {
      return { ok: false, reason: 'A world needs at least one era.' };
    }
    const era = world.eras.find((e) => e.id === id);
    const users = (await this.storage.getStoriesByWorld(world.id)).filter(
      (s) => s.eraId === id,
    );
    if (users.length > 0) {
      return { ok: false, reason: storiesUseEraMessage(era, users) };
    }

    await this.saveWorld({
      ...world,
      eras: world.eras.filter((e) => e.id !== id),
    });

    // Strip overlays that referenced the removed era.
    for (const card of this.cards()) {
      if (card.eraOverlays?.[id]) {
        const overlays = { ...card.eraOverlays };
        delete overlays[id];
        await this.updateCard({ ...card, eraOverlays: overlays });
      }
    }
    if (this.currentEraId() === id) {
      this.currentEraId.set(this.world()?.eras[0]?.id ?? '');
    }
    return { ok: true };
  }

  // --- cards --------------------------------------------------------------

  async addCard(input: NewCard): Promise<Card> {
    const world = this.world();
    const card: Card = {
      id: uuid(),
      worldId: world?.id ?? DEFAULT_WORLD_ID,
      type: input.type,
      name: input.name.trim(),
      notes: input.notes.trim(),
      source: input.source ?? 'manual',
      aliases: input.aliases?.length ? input.aliases : undefined,
      updatedAt: Date.now(),
    };
    await this.storage.putCard(card);
    this.cards.update((cards) => [...cards, card]);
    return card;
  }

  async updateCard(card: Card): Promise<void> {
    const next = { ...card, updatedAt: Date.now() };
    await this.storage.putCard(next);
    this.cards.update((cards) =>
      cards.map((c) => (c.id === next.id ? next : c)),
    );
  }

  /** Set or clear a per-era overlay on a card. Empty overlay removes the key. */
  async setOverlay(
    cardId: string,
    eraId: string,
    overlay: CardOverlay,
  ): Promise<void> {
    const card = this.cards().find((c) => c.id === cardId);
    if (!card) {
      return;
    }
    const overlays = { ...(card.eraOverlays ?? {}) };
    const name = overlay.name?.trim();
    const notes = overlay.notes?.trim();
    if (name || notes) {
      overlays[eraId] = {
        ...(name ? { name } : {}),
        ...(notes ? { notes } : {}),
      };
    } else {
      delete overlays[eraId];
    }
    await this.updateCard({
      ...card,
      eraOverlays: Object.keys(overlays).length ? overlays : undefined,
    });
  }

  async deleteCard(id: string): Promise<void> {
    await this.storage.deleteCard(id);
    this.cards.update((cards) => cards.filter((c) => c.id !== id));
  }

  /** Has this extraction name-suggestion been dismissed in this world? (case-insensitive) */
  isNameDismissed(name: string): boolean {
    const key = name.trim().toLowerCase();
    return (this.world()?.dismissedNames ?? []).includes(key);
  }

  /**
   * Remember a rejected extraction name so it never re-suggests anywhere in this
   * world. Lowercased; world-scoped because cards belong to the world.
   */
  async dismissName(name: string): Promise<void> {
    const world = this.world();
    const key = name.trim().toLowerCase();
    if (!world || key === '' || (world.dismissedNames ?? []).includes(key)) {
      return;
    }
    await this.saveWorld({
      ...world,
      dismissedNames: [...(world.dismissedNames ?? []), key],
    });
  }

  /** Soft-warning helper: does this card's name/alias appear in the prose? */
  cardAppearsInProse(card: Card, prose: string): boolean {
    const haystack = prose.toLowerCase();
    return [card.name, ...(card.aliases ?? [])].some(
      (n) => n.trim() !== '' && haystack.includes(n.toLowerCase()),
    );
  }

  private async saveWorld(world: World): Promise<void> {
    const next = { ...world, updatedAt: Date.now() };
    await this.storage.putWorld(next);
    this.world.set(next);
  }
}

function storiesUseEraMessage(era: Era | undefined, users: Story[]): string {
  const label = era ? `'${era.name}'` : 'this era';
  const n = users.length;
  return `${n} ${n === 1 ? 'story uses' : 'stories use'} ${label} — reassign or delete ${n === 1 ? 'it' : 'them'} first.`;
}
