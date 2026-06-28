import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Chapter, Story, World } from '../models/domain';
import { StorageQuotaError, StorageService } from './storage.service';

function world(over: Partial<World> = {}): World {
  return { id: 'w1', title: 'World', eras: [], updatedAt: 1, ...over };
}
function story(over: Partial<Story> = {}): Story {
  return { id: 's1', worldId: 'w1', eraId: 'e1', title: 'Story', updatedAt: 1, ...over };
}
function chapter(over: Partial<Chapter> = {}): Chapter {
  return { id: 'c1', storyId: 's1', order: 0, title: 'Ch', body: '', updatedAt: 1, ...over };
}
function card(over: Partial<Card> = {}): Card {
  return {
    id: 'k1',
    worldId: 'w1',
    type: 'character',
    name: 'Maya',
    notes: '',
    source: 'manual',
    updatedAt: 1,
    ...over,
  };
}

describe('StorageService', () => {
  let svc: StorageService;

  beforeEach(() => {
    // Fresh in-memory IndexedDB per test so state never leaks between cases.
    globalThis.indexedDB = new IDBFactory();
    svc = new StorageService();
  });

  it('round-trips a world', async () => {
    await svc.putWorld(world({ id: 'w1', title: 'Eldoria' }));
    expect(await svc.getWorld('w1')).toMatchObject({ id: 'w1', title: 'Eldoria' });
    expect(await svc.getAllWorlds()).toHaveLength(1);
  });

  it('deletes a world', async () => {
    await svc.putWorld(world());
    await svc.deleteWorld('w1');
    expect(await svc.getWorld('w1')).toBeUndefined();
  });

  it('reads stories by world via the byWorld index', async () => {
    await svc.putStory(story({ id: 's1', worldId: 'w1' }));
    await svc.putStory(story({ id: 's2', worldId: 'w1' }));
    await svc.putStory(story({ id: 's3', worldId: 'w2' }));

    const inW1 = await svc.getStoriesByWorld('w1');
    expect(inW1.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(await svc.getStoriesByWorld('w2')).toHaveLength(1);
  });

  it('reads chapters by story sorted by order', async () => {
    await svc.putChapter(chapter({ id: 'c2', storyId: 's1', order: 1 }));
    await svc.putChapter(chapter({ id: 'c1', storyId: 's1', order: 0 }));
    await svc.putChapter(chapter({ id: 'cx', storyId: 's2', order: 0 }));

    const chapters = await svc.getChaptersByStory('s1');
    expect(chapters.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(await svc.getChaptersByStory('s2')).toHaveLength(1);
  });

  it('reads cards by world via the byWorld index', async () => {
    await svc.putCard(card({ id: 'k1', worldId: 'w1' }));
    await svc.putCard(card({ id: 'k2', worldId: 'w2' }));

    const inW1 = await svc.getCardsByWorld('w1');
    expect(inW1.map((c) => c.id)).toEqual(['k1']);
  });

  it('preserves card eraOverlays through a round-trip', async () => {
    await svc.putCard(
      card({ id: 'k1', eraOverlays: { e2: { notes: 'older and wiser' } } }),
    );
    const got = await svc.getCard('k1');
    expect(got?.eraOverlays).toEqual({ e2: { notes: 'older and wiser' } });
  });

  describe('durability', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('requests persistent storage once across writes', async () => {
      const persist = vi.fn().mockResolvedValue(true);
      vi.stubGlobal('navigator', { storage: { persist } });

      await svc.putWorld(world());
      await svc.putWorld(world({ id: 'w2' }));
      await svc.putChapter(chapter());

      expect(persist).toHaveBeenCalledTimes(1);
      expect(svc.persisted()).toBe(true);
    });

    it('writes still succeed when persistence is unavailable', async () => {
      vi.stubGlobal('navigator', {});
      await svc.putWorld(world({ id: 'w1', title: 'Eldoria' }));
      expect(await svc.getWorld('w1')).toMatchObject({ title: 'Eldoria' });
      expect(svc.persisted()).toBeNull();
    });

    it('surfaces a quota error as StorageQuotaError and sets the signal', async () => {
      const quota = new DOMException('full', 'QuotaExceededError');
      vi.spyOn(svc as any, 'db').mockResolvedValue({
        put: vi.fn().mockRejectedValue(quota),
      });

      await expect(svc.putWorld(world())).rejects.toBeInstanceOf(
        StorageQuotaError,
      );
      expect(svc.quotaExceeded()).toBe(true);
    });

    it('clears the quota flag after a later write succeeds', async () => {
      svc.quotaExceeded.set(true);
      await svc.putWorld(world());
      expect(svc.quotaExceeded()).toBe(false);
    });
  });
});
