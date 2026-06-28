import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Card, Chapter, Story, World } from '../models/domain';
import {
  BackupImportError,
  BackupService,
  buildBackup,
  parseBackup,
} from './backup.service';
import { SCHEMA_VERSION, StorageService } from './storage.service';

function setup(): { backup: BackupService; storage: StorageService } {
  TestBed.configureTestingModule({
    providers: [BackupService, StorageService],
  });
  return {
    backup: TestBed.inject(BackupService),
    storage: TestBed.inject(StorageService),
  };
}

async function seed(storage: StorageService): Promise<void> {
  const world: World = {
    id: 'w1',
    title: 'My World',
    eras: [{ id: 'e1', name: 'Present day', order: 0 }],
    updatedAt: 1,
  };
  const story: Story = {
    id: 's1',
    worldId: 'w1',
    eraId: 'e1',
    title: 'A tale',
    updatedAt: 2,
  };
  const chapter: Chapter = {
    id: 'c1',
    storyId: 's1',
    order: 0,
    title: 'One',
    body: 'Once upon a time.',
    updatedAt: 3,
  };
  const card: Card = {
    id: 'card1',
    worldId: 'w1',
    type: 'character',
    name: 'Mira',
    notes: 'A scholar.',
    source: 'manual',
    updatedAt: 4,
  };
  await storage.putWorld(world);
  await storage.putStory(story);
  await storage.putChapter(chapter);
  await storage.putCard(card);
}

describe('BackupService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
  });

  it('round-trips all data through export then import', async () => {
    const { backup, storage } = setup();
    await seed(storage);

    const exported = await backup.export();
    expect(exported.schemaVersion).toBe(SCHEMA_VERSION);
    expect(exported.data.worlds).toHaveLength(1);

    // Wipe, then restore from the exported envelope.
    await storage.replaceAll({ worlds: [], stories: [], chapters: [], cards: [] });
    expect(await storage.getAllWorlds()).toHaveLength(0);

    await backup.import(exported);

    expect(await storage.getAllWorlds()).toEqual(exported.data.worlds);
    expect(await storage.getAllStories()).toEqual(exported.data.stories);
    expect(await storage.getAllChapters()).toEqual(exported.data.chapters);
    expect(await storage.getAllCards()).toEqual(exported.data.cards);
  });

  it('replaces existing data rather than merging on import', async () => {
    const { backup, storage } = setup();
    await seed(storage);
    const exported = await backup.export();

    // Add an extra world that the backup does not contain.
    await storage.putWorld({ id: 'w2', title: 'Other', eras: [], updatedAt: 9 });
    expect(await storage.getAllWorlds()).toHaveLength(2);

    await backup.import(exported);

    const worlds = await storage.getAllWorlds();
    expect(worlds).toHaveLength(1);
    expect(worlds[0].id).toBe('w1');
  });

  it('serializes and re-imports from a JSON string', async () => {
    const { backup, storage } = setup();
    await seed(storage);

    const json = await backup.serialize();
    await storage.replaceAll({ worlds: [], stories: [], chapters: [], cards: [] });
    await backup.importJson(json);

    expect(await storage.getAllCards()).toHaveLength(1);
  });

  it('rejects a backup from a newer schema version', () => {
    const future = { ...buildBackup({ worlds: [], stories: [], chapters: [], cards: [] }), schemaVersion: SCHEMA_VERSION + 1 };

    expect(() => parseBackup(future)).toThrowError(BackupImportError);
    try {
      parseBackup(future);
    } catch (err) {
      expect((err as BackupImportError).kind).toBe('unsupported_version');
      expect((err as BackupImportError).message).toContain('newer version');
    }
  });

  it('migrates an accepted version up to the current schema version', () => {
    const old = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      data: { worlds: [], stories: [], chapters: [], cards: [] },
    };

    const parsed = parseBackup(old);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects malformed payloads with a named error', () => {
    expect(() => parseBackup(null)).toThrowError(BackupImportError);
    expect(() => parseBackup({})).toThrowError(BackupImportError);
    expect(() => parseBackup({ schemaVersion: 'x', data: {} })).toThrowError(
      BackupImportError,
    );
    try {
      parseBackup({ schemaVersion: 1, data: { worlds: 'nope' } });
    } catch (err) {
      expect((err as BackupImportError).kind).toBe('malformed');
    }
  });

  it('rejects non-JSON text on importJson', async () => {
    const { backup } = setup();
    await expect(backup.importJson('not json {')).rejects.toMatchObject({
      kind: 'malformed',
    });
  });
});
