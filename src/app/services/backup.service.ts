import { Service, inject } from '@angular/core';

import type { Card, Chapter, Story, World } from '../models/domain';
import { SCHEMA_VERSION, StorageService } from './storage.service';

/** The full contents of the database, store by store. */
export interface BackupData {
  worlds: World[];
  stories: Story[];
  chapters: Chapter[];
  cards: Card[];
}

/** A versioned, self-describing backup envelope. */
export interface Backup {
  schemaVersion: number;
  exportedAt: string;
  data: BackupData;
}

export type BackupImportErrorKind = 'malformed' | 'unsupported_version';

/** Thrown when an import cannot be applied. `kind` drives the UI message. */
export class BackupImportError extends Error {
  constructor(
    readonly kind: BackupImportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BackupImportError';
  }
}

/** Wrap store contents in the current envelope. */
export function buildBackup(data: BackupData): Backup {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object');
}

/**
 * Parse and validate raw backup JSON, migrating older schema versions up to the
 * current one. Rejects malformed payloads and versions newer than this build can
 * read.
 */
export function parseBackup(raw: unknown): Backup {
  if (raw === null || typeof raw !== 'object') {
    throw new BackupImportError('malformed', 'This file is not a lekhak backup.');
  }
  const obj = raw as Record<string, unknown>;
  const version = obj['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BackupImportError(
      'malformed',
      'This file is missing a valid backup version.',
    );
  }
  const data = obj['data'];
  if (data === null || typeof data !== 'object') {
    throw new BackupImportError('malformed', 'This backup has no data.');
  }
  const d = data as Record<string, unknown>;
  if (
    !isRecordArray(d['worlds'] ?? []) ||
    !isRecordArray(d['stories'] ?? []) ||
    !isRecordArray(d['chapters'] ?? []) ||
    !isRecordArray(d['cards'] ?? [])
  ) {
    throw new BackupImportError('malformed', 'This backup is corrupted.');
  }

  if (version > SCHEMA_VERSION) {
    throw new BackupImportError(
      'unsupported_version',
      `This backup was made by a newer version of lekhak (v${version}). Update lekhak, then import it.`,
    );
  }

  return migrate({
    schemaVersion: version,
    exportedAt: typeof obj['exportedAt'] === 'string' ? obj['exportedAt'] : '',
    data: {
      worlds: (d['worlds'] as World[]) ?? [],
      stories: (d['stories'] as Story[]) ?? [],
      chapters: (d['chapters'] as Chapter[]) ?? [],
      cards: (d['cards'] as Card[]) ?? [],
    },
  });
}

/**
 * Upgrade an older backup to the current schema. v1 is the current version, so
 * this is identity for now; future schema bumps add their migration step here
 * and bump the returned `schemaVersion`.
 */
function migrate(backup: Backup): Backup {
  // No older versions exist yet. When SCHEMA_VERSION advances, branch on
  // `backup.schemaVersion` and transform `backup.data` in place, oldest first.
  return { ...backup, schemaVersion: SCHEMA_VERSION };
}

/**
 * Export and import the whole database as a single JSON file. Export gathers
 * every store into a versioned envelope; import replaces all existing data with
 * the (validated, migrated) backup contents.
 */
@Service()
export class BackupService {
  private readonly storage = inject(StorageService);

  /** Read all stores into a versioned backup envelope. */
  async export(): Promise<Backup> {
    const [worlds, stories, chapters, cards] = await Promise.all([
      this.storage.getAllWorlds(),
      this.storage.getAllStories(),
      this.storage.getAllChapters(),
      this.storage.getAllCards(),
    ]);
    return buildBackup({ worlds, stories, chapters, cards });
  }

  /** Serialize the current database to pretty-printed backup JSON. */
  async serialize(): Promise<string> {
    return JSON.stringify(await this.export(), null, 2);
  }

  /** Validate, migrate, and apply a backup, replacing all existing data. */
  async import(raw: unknown): Promise<void> {
    const backup = parseBackup(raw);
    await this.storage.replaceAll(backup.data);
  }

  /** Parse a JSON string and import it. Throws BackupImportError on bad JSON. */
  async importJson(json: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new BackupImportError('malformed', 'This file is not valid JSON.');
    }
    await this.import(parsed);
  }
}
