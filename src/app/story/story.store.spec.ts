import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Chapter, Story } from '../models/domain';
import { MAX_CHAPTERS, StorageService } from '../services/storage.service';
import {
  DEFAULT_CHAPTER_ID,
  DEFAULT_STORY_ID,
  StoryStore,
} from './story.store';

const WORLD = 'world-1';
const ERA = 'era-1';

function setup(): { store: StoryStore; storage: StorageService } {
  TestBed.configureTestingModule({ providers: [StoryStore, StorageService] });
  return {
    store: TestBed.inject(StoryStore),
    storage: TestBed.inject(StorageService),
  };
}

describe('StoryStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('bootstraps a first story adopting the legacy default ids on first run', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);

    expect(store.stories()).toHaveLength(1);
    expect(store.activeStory()!.id).toBe(DEFAULT_STORY_ID);
    expect(store.chapters()).toHaveLength(1);
    expect(store.activeChapter()!.id).toBe(DEFAULT_CHAPTER_ID);
    expect(store.ready()).toBe(true);
  });

  it('adopts a pre-store draft under default-chapter without overwriting it', async () => {
    const { store, storage } = setup();
    // Simulate a draft written by the old editor: a chapter, but no story record.
    const draft: Chapter = {
      id: DEFAULT_CHAPTER_ID,
      storyId: DEFAULT_STORY_ID,
      order: 0,
      title: 'Untitled',
      body: 'Once upon a midnight dreary.',
      updatedAt: 1,
    };
    await storage.putChapter(draft);

    await store.init(WORLD, ERA);

    expect(store.chapters()).toHaveLength(1);
    expect(store.activeChapter()!.id).toBe(DEFAULT_CHAPTER_ID);
    expect(store.activeChapter()!.body).toBe('Once upon a midnight dreary.');
  });

  it('restores the active selection on a second init', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    await store.createChapter();
    const secondChapterId = store.activeChapterId();

    TestBed.resetTestingModule();
    const next = setup();
    await next.store.init(WORLD, ERA);

    expect(next.store.activeChapterId()).toBe(secondChapterId);
  });

  it('createStory adds a story with one empty chapter and selects it', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);

    await store.createStory('A Second Tale', WORLD, ERA);

    expect(store.stories()).toHaveLength(2);
    expect(store.activeStory()!.title).toBe('A Second Tale');
    expect(store.chapters()).toHaveLength(1);
    expect(store.activeChapter()!.body).toBe('');
  });

  it('createStory locks in the chosen writing style', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);

    await store.createStory('A Tender Tale', WORLD, ERA, 'romance');

    expect(store.activeStory()!.styleId).toBe('romance');
  });

  it('createStory defaults the style to the banter persona', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);

    await store.createStory('Default Style', WORLD, ERA);

    expect(store.activeStory()!.styleId).toBe('banter');
  });

  it('createChapter appends at order max+1 and selects the new chapter', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);

    const ok = await store.createChapter();

    expect(ok).toBe(true);
    expect(store.chapters()).toHaveLength(2);
    expect(store.chapters()[1].order).toBe(1);
    expect(store.activeChapterId()).toBe(store.chapters()[1].id);
  });

  it('blocks createChapter once a story is at the chapter cap', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    for (let i = 1; i < MAX_CHAPTERS; i++) {
      expect(await store.createChapter()).toBe(true);
    }
    expect(store.chapters()).toHaveLength(MAX_CHAPTERS);
    expect(store.atChapterCap()).toBe(true);

    const blocked = await store.createChapter();

    expect(blocked).toBe(false);
    expect(store.chapters()).toHaveLength(MAX_CHAPTERS);
  });

  it('reports isLatestActive only when the active chapter is the highest order', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    await store.createChapter();
    expect(store.isLatestActive()).toBe(true);

    store.stepChapter(-1);
    expect(store.activeChapterNumber()).toBe(1);
    expect(store.isLatestActive()).toBe(false);
  });

  it('saveActiveBody persists the body and updates the in-memory chapter', async () => {
    const { store, storage } = setup();
    await store.init(WORLD, ERA);

    await store.saveActiveBody('New prose.');

    expect(store.activeChapter()!.body).toBe('New prose.');
    const persisted = await storage.getChapter(store.activeChapterId());
    expect(persisted!.body).toBe('New prose.');
  });

  it('deleting the active chapter reselects the prior chapter', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    const first = store.activeChapterId();
    await store.createChapter();
    const second = store.activeChapterId();

    await store.deleteChapter(second);

    expect(store.chapters()).toHaveLength(1);
    expect(store.activeChapterId()).toBe(first);
  });

  it('deleting the only chapter recreates a fresh Chapter 1', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    const only = store.activeChapterId();

    await store.deleteChapter(only);

    expect(store.chapters()).toHaveLength(1);
    expect(store.activeChapterId()).not.toBe(only);
    expect(store.activeChapter()!.body).toBe('');
  });

  it('deleting the active story falls back to another story', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    const first = store.activeStoryId();
    await store.createStory('Second', WORLD, ERA);
    const second = store.activeStoryId();

    await store.deleteStory(second);

    expect(store.stories()).toHaveLength(1);
    expect(store.activeStoryId()).toBe(first);
  });

  it('deleting the last story bootstraps a fresh one', async () => {
    const { store } = setup();
    await store.init(WORLD, ERA);
    const only = store.activeStoryId();

    await store.deleteStory(only);

    expect(store.stories()).toHaveLength(1);
    expect(store.activeStoryId()).not.toBe(only);
    expect(store.chapters()).toHaveLength(1);
  });

  it('removes a deleted story and its chapters from storage', async () => {
    const { store, storage } = setup();
    await store.init(WORLD, ERA);
    await store.createStory('Doomed', WORLD, ERA);
    const doomed = store.activeStoryId();
    const chapterId = store.activeChapterId();

    await store.deleteStory(doomed);

    expect(await storage.getStory(doomed)).toBeUndefined();
    expect(await storage.getChapter(chapterId)).toBeUndefined();
  });

  describe('moveChapter', () => {
    it('swaps order and renumbers auto-labels while keeping the active selection', async () => {
      const { store } = setup();
      await store.init(WORLD, ERA);
      await store.createChapter(); // Chapter 2
      await store.createChapter(); // Chapter 3
      const first = store.chapters()[0];
      const second = store.chapters()[1];
      store.selectChapter(second.id);

      await store.moveChapter(second.id, -1);

      const ordered = store.chapters();
      expect(ordered.map((c) => c.id)).toEqual([
        second.id,
        first.id,
        ordered[2].id,
      ]);
      expect(ordered[0].order).toBe(0);
      expect(ordered[1].order).toBe(1);
      // Auto-labels track the new positions.
      expect(ordered[0].title).toBe('Chapter 1');
      expect(ordered[1].title).toBe('Chapter 2');
      // The moved chapter stays active; its position number follows.
      expect(store.activeChapterId()).toBe(second.id);
      expect(store.activeChapterNumber()).toBe(1);
    });

    it('is a no-op at the ends', async () => {
      const { store } = setup();
      await store.init(WORLD, ERA);
      await store.createChapter();
      const before = store.chapters().map((c) => c.id);

      await store.moveChapter(before[0], -1); // already first
      await store.moveChapter(before[before.length - 1], 1); // already last

      expect(store.chapters().map((c) => c.id)).toEqual(before);
    });
  });
});
