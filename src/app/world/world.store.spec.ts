import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Story } from '../models/domain';
import { StorageService } from '../services/storage.service';
import { WorldStore } from './world.store';

function setup(): { store: WorldStore; storage: StorageService } {
  TestBed.configureTestingModule({ providers: [WorldStore, StorageService] });
  return {
    store: TestBed.inject(WorldStore),
    storage: TestBed.inject(StorageService),
  };
}

describe('WorldStore', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
  });

  it('bootstraps a default world with one era on first init', async () => {
    const { store } = setup();
    await store.init();

    expect(store.world()).not.toBeNull();
    expect(store.eras()).toHaveLength(1);
    expect(store.currentEraId()).toBe(store.eras()[0].id);
    expect(store.ready()).toBe(true);
  });

  it('reuses the persisted world on a second init', async () => {
    const { store } = setup();
    await store.init();
    await store.addEra('Five years on');
    const worldId = store.world()!.id;

    TestBed.resetTestingModule();
    const next = setup();
    await next.store.init();

    expect(next.store.world()!.id).toBe(worldId);
    expect(next.store.eras()).toHaveLength(2);
  });

  it('adds, renames, and reorders eras', async () => {
    const { store } = setup();
    await store.init();
    await store.addEra('Later');
    const [first, second] = store.eras();

    await store.renameEra(second.id, 'Much later');
    expect(store.eras().find((e) => e.id === second.id)!.name).toBe(
      'Much later',
    );

    await store.moveEra(second.id, -1);
    expect(store.eras()[0].id).toBe(second.id);
    expect(store.eras()[1].id).toBe(first.id);
  });

  it('blocks deleting an era that a story is anchored to, with a named message', async () => {
    const { store, storage } = setup();
    await store.init();
    await store.addEra('Five years on');
    const era = store.eras().find((e) => e.name === 'Five years on')!;

    const story: Story = {
      id: 's1',
      worldId: store.world()!.id,
      eraId: era.id,
      title: 'A tale',
      updatedAt: Date.now(),
    };
    await storage.putStory(story);

    const result = await store.deleteEra(era.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("'Five years on'");
      expect(result.reason).toContain('1 story');
    }
    expect(store.eras().some((e) => e.id === era.id)).toBe(true);
  });

  it('blocks deleting the last remaining era', async () => {
    const { store } = setup();
    await store.init();
    const only = store.eras()[0];

    const result = await store.deleteEra(only.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('at least one era');
    }
  });

  it('deletes an unused era and strips its overlays from cards', async () => {
    const { store } = setup();
    await store.init();
    await store.addEra('Later');
    const later = store.eras().find((e) => e.name === 'Later')!;

    const card = await store.addCard({
      type: 'character',
      name: 'Mira',
      notes: 'A scholar.',
    });
    await store.setOverlay(card.id, later.id, { notes: 'A queen.' });
    expect(store.cards()[0].eraOverlays?.[later.id]).toBeTruthy();

    const result = await store.deleteEra(later.id);
    expect(result.ok).toBe(true);
    expect(store.eras().some((e) => e.id === later.id)).toBe(false);
    expect(store.cards()[0].eraOverlays?.[later.id]).toBeUndefined();
  });

  it('creates, updates, and deletes cards', async () => {
    const { store } = setup();
    await store.init();

    const card = await store.addCard({
      type: 'place',
      name: 'Harbor',
      notes: 'A grey port.',
    });
    expect(store.cards()).toHaveLength(1);

    await store.updateCard({ ...card, notes: 'A grey port at dawn.' });
    expect(store.cards()[0].notes).toBe('A grey port at dawn.');

    await store.deleteCard(card.id);
    expect(store.cards()).toHaveLength(0);
  });

  it('sets and clears per-era overlays', async () => {
    const { store } = setup();
    await store.init();
    await store.addEra('Later');
    const later = store.eras().find((e) => e.name === 'Later')!;
    const card = await store.addCard({
      type: 'character',
      name: 'Mira',
      notes: 'A scholar.',
    });

    await store.setOverlay(card.id, later.id, { name: 'Queen Mira' });
    expect(store.cards()[0].eraOverlays?.[later.id]?.name).toBe('Queen Mira');

    await store.setOverlay(card.id, later.id, {});
    expect(store.cards()[0].eraOverlays?.[later.id]).toBeUndefined();
  });

  it('detects a card name appearing in prose for the soft warning', async () => {
    const { store } = setup();
    await store.init();
    const card = await store.addCard({
      type: 'character',
      name: 'Mira',
      notes: '',
    });

    expect(store.cardAppearsInProse(card, 'And so Mira walked on.')).toBe(true);
    expect(store.cardAppearsInProse(card, 'Nobody was here.')).toBe(false);
  });
});
