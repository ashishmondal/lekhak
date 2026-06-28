import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AiError } from '../ai/ai-error';
import type {
  AiProvider,
  ChatMessage,
  GenerateOpts,
} from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { StorageService } from '../services/storage.service';
import { WorldStore } from '../world/world.store';
import { BackgroundQueue } from './background-queue';
import {
  ExtractionService,
  type ExtractionInput,
} from './extraction.service';
import { SettingsService } from './settings.service';

/** A chapter long enough to clear the MIN_CHAPTER_CHARS material gate. */
const BODY =
  'Brann the ferryman waited at the Salt Gate as the tide turned. He had carried ' +
  'the old king across the Mere a hundred times, and tonight he carried a girl who ' +
  'would not give her name. The lantern swung over black water while gulls wheeled ' +
  'above the drowned towers of Esh.';

const TWO_CARDS =
  '{"cards":[' +
  '{"type":"character","name":"Brann","aliases":["the ferryman"],"notes":"A ferryman at the Salt Gate."},' +
  '{"type":"place","name":"Esh","notes":"A drowned city of towers."}' +
  ']}';

class StubProvider implements AiProvider {
  readonly id = 'stub';
  calls = 0;
  constructor(
    private readonly response: string,
    private readonly throwError?: AiError,
  ) {}
  async *generate(
    _messages: ChatMessage[],
    _opts: GenerateOpts,
  ): AsyncGenerator<string> {
    this.calls++;
    if (this.throwError) {
      throw this.throwError;
    }
    yield this.response;
  }
  async testConnection(): Promise<boolean> {
    return true;
  }
}

async function setup(provider: AiProvider): Promise<{
  svc: ExtractionService;
  settings: SettingsService;
  world: WorldStore;
}> {
  TestBed.configureTestingModule({
    providers: [
      ExtractionService,
      BackgroundQueue,
      SettingsService,
      WorldStore,
      StorageService,
      { provide: AI_PROVIDER, useValue: provider },
    ],
  });
  const world = TestBed.inject(WorldStore);
  await world.init();
  return {
    svc: TestBed.inject(ExtractionService),
    settings: TestBed.inject(SettingsService),
    world,
  };
}

function input(body = BODY): ExtractionInput {
  return { chapterId: 'ch1', body };
}

describe('ExtractionService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('does nothing when the extraction toggle is off', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc } = await setup(provider);

    await svc.onChapterFinalized(input());

    expect(provider.calls).toBe(0);
    expect(svc.suggestions()).toEqual([]);
  });

  it('suggests new entities from a finalized chapter', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input());

    const names = svc.suggestions().map((s) => s.name);
    expect(names).toEqual(['Brann', 'Esh']);
    expect(svc.extractionError()).toBe(false);
  });

  it('dedupes against existing card names and aliases', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings, world } = await setup(provider);
    settings.setExtraction(true);
    // Brann already exists (as an alias here); only Esh should remain.
    await world.addCard({
      type: 'character',
      name: 'The Ferryman',
      notes: '',
      aliases: ['Brann'],
    });

    await svc.onChapterFinalized(input());

    expect(svc.suggestions().map((s) => s.name)).toEqual(['Esh']);
  });

  it('Accept creates an extracted card and drops the suggestion', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings, world } = await setup(provider);
    settings.setExtraction(true);
    await svc.onChapterFinalized(input());

    const brann = svc.suggestions().find((s) => s.name === 'Brann')!;
    const card = await svc.accept(brann);

    expect(card.source).toBe('extracted');
    expect(card.aliases).toEqual(['the ferryman']);
    expect(world.cards().some((c) => c.name === 'Brann')).toBe(true);
    // It is gone from the tray (both removed and now a known name).
    expect(svc.suggestions().map((s) => s.name)).toEqual(['Esh']);
  });

  it('Dismiss remembers the name world-wide and never re-suggests it', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings, world } = await setup(provider);
    settings.setExtraction(true);
    await svc.onChapterFinalized(input());

    const esh = svc.suggestions().find((s) => s.name === 'Esh')!;
    await svc.dismiss(esh);

    expect(world.isNameDismissed('Esh')).toBe(true);
    expect(svc.suggestions().map((s) => s.name)).toEqual(['Brann']);

    // A later extraction of the same name stays suppressed.
    await svc.onChapterFinalized(input(`${BODY} The name Esh echoed again here.`));
    expect(svc.suggestions().some((s) => s.name === 'Esh')).toBe(false);
  });

  it('never auto-creates a card (suggest-only)', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings, world } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input());

    expect(world.cards()).toHaveLength(0); // nothing written without Accept
    expect(svc.suggestions()).toHaveLength(2);
  });

  it('coalesces a repeat trigger on the same chapter text', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input());
    await svc.onChapterFinalized(input());
    expect(provider.calls).toBe(1);
  });

  it('skips a chapter too short to mine', async () => {
    const provider = new StubProvider(TWO_CARDS);
    const { svc, settings } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input('A short note.'));
    expect(provider.calls).toBe(0);
  });

  it('surfaces a visible failure on malformed JSON', async () => {
    const provider = new StubProvider('No JSON here.');
    const { svc, settings } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input());

    expect(svc.extractionError()).toBe(true);
    expect(svc.suggestions()).toEqual([]);
  });

  it('surfaces a visible failure on a provider error', async () => {
    const provider = new StubProvider('', new AiError('rate_limit', 'slow down'));
    const { svc, settings } = await setup(provider);
    settings.setExtraction(true);

    await svc.onChapterFinalized(input());

    expect(svc.extractionError()).toBe(true);
  });
});
