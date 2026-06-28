import { Service, signal } from '@angular/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Card, Chapter, Story, World } from '../models/domain';

const DB_NAME = 'lekhak';
const DB_VERSION = 1;

/** Current IndexedDB schema version. Backups carry this so imports can guard. */
export const SCHEMA_VERSION = DB_VERSION;

/** A story may hold at most this many chapters. */
export const MAX_CHAPTERS = 6;

/** Thrown when a write fails because the browser storage quota is exhausted. */
export class StorageQuotaError extends Error {
  constructor(
    message = 'Your browser storage is full. Export a backup, then free some space.',
  ) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.code === 22)
  );
}

interface LekhakDB extends DBSchema {
  worlds: {
    key: string;
    value: World;
  };
  stories: {
    key: string;
    value: Story;
    indexes: { byWorld: string };
  };
  chapters: {
    key: string;
    value: Chapter;
    indexes: { byStory: string };
  };
  cards: {
    key: string;
    value: Card;
    indexes: { byWorld: string };
  };
}

/**
 * The single IndexedDB chokepoint. Every store read/write goes through here.
 *
 * Transaction discipline: each method below uses idb's per-call auto-transaction
 * (one store, one tx). Any future compound operation that spans stores MUST keep
 * all `store.put`/`store.delete` calls inside one transaction with no intervening
 * non-store `await` — otherwise idb auto-commits the tx on the first such await.
 */
@Service()
export class StorageService {
  private dbPromise: Promise<IDBPDatabase<LekhakDB>> | null = null;

  /**
   * Whether the browser granted persistent storage (so the OS won't silently
   * evict the database under pressure). `null` until the first write asks.
   */
  readonly persisted = signal<boolean | null>(null);
  /** Set when a write failed because the storage quota was exceeded. */
  readonly quotaExceeded = signal(false);

  private persistenceRequested = false;

  /**
   * Ask the browser to keep this origin's storage durable. Best-effort and
   * fired once, lazily, on the first write — calling it eagerly at construction
   * can prompt the user before they've done anything worth persisting.
   */
  private async ensurePersistence(): Promise<void> {
    if (this.persistenceRequested) {
      return;
    }
    this.persistenceRequested = true;
    try {
      const storage = globalThis.navigator?.storage;
      if (storage?.persist) {
        this.persisted.set(await storage.persist());
      }
    } catch {
      // Persistence is a hint, not a guarantee; never block a write on it.
    }
  }

  /**
   * Run a write, requesting persistence first and translating a quota failure
   * into a typed {@link StorageQuotaError} the UI can surface.
   */
  private async write(op: () => Promise<unknown>): Promise<void> {
    await this.ensurePersistence();
    try {
      await op();
      if (this.quotaExceeded()) {
        this.quotaExceeded.set(false); // a successful write means we recovered
      }
    } catch (err) {
      if (isQuotaError(err)) {
        this.quotaExceeded.set(true);
        throw new StorageQuotaError();
      }
      throw err;
    }
  }

  private db(): Promise<IDBPDatabase<LekhakDB>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<LekhakDB>(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion) {
          // Version 1: create all stores + indexes. `oldVersion` lets future
          // versions branch their migrations from here without a rewrite.
          if (oldVersion < 1) {
            db.createObjectStore('worlds', { keyPath: 'id' });

            const stories = db.createObjectStore('stories', { keyPath: 'id' });
            stories.createIndex('byWorld', 'worldId');

            const chapters = db.createObjectStore('chapters', { keyPath: 'id' });
            chapters.createIndex('byStory', 'storyId');

            const cards = db.createObjectStore('cards', { keyPath: 'id' });
            cards.createIndex('byWorld', 'worldId');
          }
        },
      });
    }
    return this.dbPromise;
  }

  // --- worlds -------------------------------------------------------------

  async putWorld(world: World): Promise<void> {
    await this.write(async () => (await this.db()).put('worlds', world));
  }

  async getWorld(id: string): Promise<World | undefined> {
    return (await this.db()).get('worlds', id);
  }

  async getAllWorlds(): Promise<World[]> {
    return (await this.db()).getAll('worlds');
  }

  async deleteWorld(id: string): Promise<void> {
    await (await this.db()).delete('worlds', id);
  }

  // --- stories ------------------------------------------------------------

  async putStory(story: Story): Promise<void> {
    await this.write(async () => (await this.db()).put('stories', story));
  }

  async getStory(id: string): Promise<Story | undefined> {
    return (await this.db()).get('stories', id);
  }

  async getStoriesByWorld(worldId: string): Promise<Story[]> {
    return (await this.db()).getAllFromIndex('stories', 'byWorld', worldId);
  }

  async getAllStories(): Promise<Story[]> {
    return (await this.db()).getAll('stories');
  }

  async deleteStory(id: string): Promise<void> {
    await (await this.db()).delete('stories', id);
  }

  // --- chapters -----------------------------------------------------------

  async putChapter(chapter: Chapter): Promise<void> {
    await this.write(async () => (await this.db()).put('chapters', chapter));
  }

  async getChapter(id: string): Promise<Chapter | undefined> {
    return (await this.db()).get('chapters', id);
  }

  /** Chapters for a story, sorted by `order` (ascending). */
  async getChaptersByStory(storyId: string): Promise<Chapter[]> {
    const chapters = await (await this.db()).getAllFromIndex(
      'chapters',
      'byStory',
      storyId,
    );
    return chapters.sort((a, b) => a.order - b.order);
  }

  async deleteChapter(id: string): Promise<void> {
    await (await this.db()).delete('chapters', id);
  }

  async getAllChapters(): Promise<Chapter[]> {
    return (await this.db()).getAll('chapters');
  }

  // --- cards --------------------------------------------------------------

  async putCard(card: Card): Promise<void> {
    await this.write(async () => (await this.db()).put('cards', card));
  }

  async getCard(id: string): Promise<Card | undefined> {
    return (await this.db()).get('cards', id);
  }

  async getCardsByWorld(worldId: string): Promise<Card[]> {
    return (await this.db()).getAllFromIndex('cards', 'byWorld', worldId);
  }

  async getAllCards(): Promise<Card[]> {
    return (await this.db()).getAll('cards');
  }

  async deleteCard(id: string): Promise<void> {
    await (await this.db()).delete('cards', id);
  }

  // --- bulk ---------------------------------------------------------------

  /**
   * Replace the entire database with the given records, in one transaction per
   * store. Used by backup import: every existing record is cleared first so the
   * restore is an exact replacement, not a merge.
   */
  async replaceAll(data: {
    worlds: World[];
    stories: Story[];
    chapters: Chapter[];
    cards: Card[];
  }): Promise<void> {
    await this.write(async () => {
      const db = await this.db();
      const tx = db.transaction(
        ['worlds', 'stories', 'chapters', 'cards'],
        'readwrite',
      );
      await Promise.all([
        tx.objectStore('worlds').clear(),
        tx.objectStore('stories').clear(),
        tx.objectStore('chapters').clear(),
        tx.objectStore('cards').clear(),
      ]);
      for (const world of data.worlds) {
        void tx.objectStore('worlds').put(world);
      }
      for (const story of data.stories) {
        void tx.objectStore('stories').put(story);
      }
      for (const chapter of data.chapters) {
        void tx.objectStore('chapters').put(chapter);
      }
      for (const card of data.cards) {
        void tx.objectStore('cards').put(card);
      }
      await tx.done;
    });
  }
}
