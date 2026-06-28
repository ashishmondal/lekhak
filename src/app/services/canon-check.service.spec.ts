import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError } from '../ai/ai-error';
import type {
  AiProvider,
  ChatMessage,
  GenerateOpts,
} from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import type { Card } from '../models/domain';
import { StoryStore } from '../story/story.store';
import { StorageService } from '../services/storage.service';
import { BackgroundQueue } from './background-queue';
import {
  CanonCheckService,
  DRIFT_IDLE_MS,
  type DriftCheckInput,
} from './canon-check.service';
import { SettingsService } from './settings.service';

const WORLD = 'world-1';
const ERA = 'era-1';

/** A long-enough draft to clear the MIN_DRAFT_CHARS material gate. */
const DRAFT =
  'Mira pushed back her bright red hair and stepped into the harbor at dawn. ' +
  'The grey water lapped at the stones as she counted the ships that had not ' +
  'returned, one for every year she had waited at the wall.';

const CARDS: Card[] = [
  {
    id: 'c1',
    worldId: WORLD,
    type: 'character',
    name: 'Mira',
    notes: 'A scholar with jet-black hair.',
    source: 'manual',
    updatedAt: 1,
  },
];

/** A provider that records call count and returns a scripted response. */
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

const ONE_FLAG =
  '{"flags":[{"card":"Mira","issue":"The draft gives Mira red hair; canon says jet-black."}]}';

function setup(provider: AiProvider): {
  svc: CanonCheckService;
  settings: SettingsService;
  stories: StoryStore;
} {
  TestBed.configureTestingModule({
    providers: [
      CanonCheckService,
      BackgroundQueue,
      SettingsService,
      StoryStore,
      StorageService,
      { provide: AI_PROVIDER, useValue: provider },
    ],
  });
  return {
    svc: TestBed.inject(CanonCheckService),
    settings: TestBed.inject(SettingsService),
    stories: TestBed.inject(StoryStore),
  };
}

async function initStory(stories: StoryStore): Promise<string> {
  await stories.init(WORLD, ERA);
  return stories.activeStoryId();
}

function input(storyId: string, draft = DRAFT): DriftCheckInput {
  return { storyId, draft, cards: CARDS };
}

describe('CanonCheckService — drift', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing when the drift toggle is off (no provider call)', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, stories } = setup(provider);
    const id = await initStory(stories);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id)); // toggle defaults OFF

    expect(provider.calls).toBe(0);
    expect(svc.driftFlags()).toEqual([]);
  });

  it('flags a contradiction between the draft and canon', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id));

    expect(provider.calls).toBe(1);
    expect(svc.driftFlags()).toHaveLength(1);
    expect(svc.driftFlags()[0].card).toBe('Mira');
    expect(svc.driftError()).toBe(false);
  });

  it('gates on a material change — an unchanged draft is not re-analyzed', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id));
    await svc.runDriftCheck(input(id)); // identical text → gated
    expect(provider.calls).toBe(1);

    // Whitespace-only change is still immaterial.
    await svc.runDriftCheck(input(id, `  ${DRAFT}\n`));
    expect(provider.calls).toBe(1);

    // A real edit re-runs.
    await svc.runDriftCheck(input(id, `${DRAFT} She drew her blade.`));
    expect(provider.calls).toBe(2);
  });

  it('ignores a draft too short to judge', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id, 'Too short.'));
    expect(provider.calls).toBe(0);
  });

  it('remembers dismissed flags so they never re-surface', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id));
    const flagId = svc.driftFlags()[0].id;

    await svc.dismissDrift(flagId);
    expect(svc.driftFlags()).toEqual([]);

    // Re-running the same analysis does not bring it back.
    await svc.runDriftCheck(input(id, `${DRAFT} A gull cried.`));
    expect(svc.driftFlags()).toEqual([]);
  });

  it('surfaces a visible failure on malformed JSON', async () => {
    const provider = new StubProvider('Sorry, I cannot help with that.');
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id));

    expect(svc.driftError()).toBe(true);
    expect(svc.driftFlags()).toEqual([]);
  });

  it('surfaces a visible failure on a provider error', async () => {
    const provider = new StubProvider('', new AiError('network', 'down'));
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    await svc.runDriftCheck(input(id));

    expect(svc.driftError()).toBe(true);
  });

  it('debounces idle-triggered checks into a single run', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setDriftCheck(true);
    svc.activeStoryId.set(id);

    vi.useFakeTimers();
    svc.noteDraftChanged(input(id));
    svc.noteDraftChanged(input(id)); // resets the timer
    svc.noteDraftChanged(input(id));
    await vi.advanceTimersByTimeAsync(DRIFT_IDLE_MS);

    expect(provider.calls).toBe(1);
  });
});

describe('CanonCheckService — full canon', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('makes no provider call when the canon toggle is off', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, stories } = setup(provider);
    const id = await initStory(stories);
    svc.activeStoryId.set(id);

    await svc.runCanonCheck(input(id)); // canon toggle defaults OFF

    expect(provider.calls).toBe(0);
    expect(svc.driftFlags()).toEqual([]);
  });

  it('runs a flag-only check when the canon toggle is on', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setCanonCheck(true);
    svc.activeStoryId.set(id);

    await svc.runCanonCheck(input(id));

    expect(provider.calls).toBe(1);
    expect(svc.driftFlags()).toHaveLength(1);
    expect(svc.driftFlags()[0].card).toBe('Mira');
    expect(svc.driftError()).toBe(false);
  });

  it('ignores the drift material-diff gate (always runs on demand)', async () => {
    const provider = new StubProvider(ONE_FLAG);
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setCanonCheck(true);
    svc.activeStoryId.set(id);

    await svc.runCanonCheck(input(id));
    await svc.runCanonCheck(input(id)); // same text still re-runs on demand
    expect(provider.calls).toBe(2);
  });

  it('surfaces a visible failure on a provider error', async () => {
    const provider = new StubProvider('', new AiError('network', 'down'));
    const { svc, settings, stories } = setup(provider);
    const id = await initStory(stories);
    settings.setCanonCheck(true);
    svc.activeStoryId.set(id);

    await svc.runCanonCheck(input(id));

    expect(svc.driftError()).toBe(true);
  });
});
