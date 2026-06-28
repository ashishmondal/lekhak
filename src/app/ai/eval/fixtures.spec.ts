import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AiProvider } from '../ai-provider';
import { AI_PROVIDER } from '../ai-provider.token';
import { GeminiProvider } from '../gemini-provider';
import { OpenAiProvider } from '../openai-provider';
import type { Card } from '../../models/domain';
import { BackgroundQueue } from '../../services/background-queue';
import { CanonCheckService } from '../../services/canon-check.service';
import { ExtractionService } from '../../services/extraction.service';
import { SettingsService } from '../../services/settings.service';
import { StorageService } from '../../services/storage.service';
import { StoryStore } from '../../story/story.store';
import { WorldStore } from '../../world/world.store';

/**
 * Quality eval for the LLM judges (drift, full canon, extraction). Unlike the
 * unit specs — which prove the plumbing against a FakeProvider — this exercises
 * the prompts against a REAL provider and asserts the judgments are good.
 *
 * It is **off by default** and skipped in CI: nothing runs unless a key is
 * supplied. To run it locally:
 *
 *   LEKHAK_EVAL_KEY=sk-... npx ng test --no-watch
 *
 * Optional knobs: `LEKHAK_EVAL_PROVIDER` (`openai` | `gemini`, default
 * `openai`) and `LEKHAK_EVAL_MODEL` (defaults to the provider default). These
 * make real, paid network calls, so each case carries a generous timeout.
 *
 * This is intentionally a *small* fixture eval — the full labelled harness is
 * deferred (see TODOS.md TD2).
 */
const ENV: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};
const KEY = ENV['LEKHAK_EVAL_KEY'];
const PROVIDER = ENV['LEKHAK_EVAL_PROVIDER'] ?? 'openai';
const MODEL = ENV['LEKHAK_EVAL_MODEL'] || undefined;
const TIMEOUT = 30_000;

const WORLD = 'world-eval';
const ERA = 'era-eval';

function realProvider(): AiProvider {
  return PROVIDER === 'gemini'
    ? new GeminiProvider({ apiKey: KEY! })
    : new OpenAiProvider({ apiKey: KEY! });
}

const MIRA: Card = {
  id: 'c1',
  worldId: WORLD,
  type: 'character',
  name: 'Mira',
  notes:
    'A harbor scholar with jet-black hair. She lost her left hand in the fire ' +
    'at Saltmere and now wears a brass hook in its place.',
  source: 'manual',
  updatedAt: 1,
};

/** Draft that plainly contradicts Mira's canon (hair colour + the lost hand). */
const CONTRADICTION =
  'Mira shook out her long red hair as she crossed the quay, and with both ' +
  'steady hands she hauled the wet rope up over the rail, knuckles white in ' +
  'the cold dawn light.';

/** Draft that is consistent with Mira's canon. */
const CONSISTENT =
  'Mira tucked a strand of black hair behind her ear and steadied the rope ' +
  'against her brass hook, working it taut with her one good hand as the grey ' +
  'water slapped the stones below.';

/** A chapter introducing entities not in the (empty) World. */
const NEW_ENTITIES =
  'Captain Eli Holloway met them at the end of the pier, his weathered coat ' +
  'heavy with salt. He had sailed the Saltmere run for thirty years and knew ' +
  'every reef by name. Beside him stood the navigator Wren, who carried the ' +
  'old brass astrolabe that had guided three generations of the Holloway line ' +
  'across the Drowned Strait at night.';

interface Judges {
  drift: CanonCheckService;
  extraction: ExtractionService;
  settings: SettingsService;
  stories: StoryStore;
  world: WorldStore;
}

async function setup(): Promise<Judges> {
  TestBed.configureTestingModule({
    providers: [
      { provide: AI_PROVIDER, useValue: realProvider() },
      CanonCheckService,
      ExtractionService,
      SettingsService,
      StoryStore,
      WorldStore,
      StorageService,
      BackgroundQueue,
    ],
  });
  const judges: Judges = {
    drift: TestBed.inject(CanonCheckService),
    extraction: TestBed.inject(ExtractionService),
    settings: TestBed.inject(SettingsService),
    stories: TestBed.inject(StoryStore),
    world: TestBed.inject(WorldStore),
  };
  await judges.world.init();
  await judges.stories.init(WORLD, ERA);
  return judges;
}

// The whole suite vanishes when no key is present — this is what keeps it out
// of CI while still letting a developer run it on demand.
describe.skipIf(!KEY)('judge quality eval (key-gated, real provider)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it(
    'drift check catches a planted contradiction',
    async () => {
      const { drift, settings, stories } = await setup();
      settings.setDriftCheck(true);
      const storyId = stories.activeStoryId();
      drift.activeStoryId.set(storyId);

      await drift.runDriftCheck({
        storyId,
        draft: CONTRADICTION,
        cards: [MIRA],
        model: MODEL,
      });

      expect(drift.driftError()).toBe(false);
      expect(drift.driftFlags().length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'drift check stays quiet on a consistent draft',
    async () => {
      const { drift, settings, stories } = await setup();
      settings.setDriftCheck(true);
      const storyId = stories.activeStoryId();
      drift.activeStoryId.set(storyId);

      await drift.runDriftCheck({
        storyId,
        draft: CONSISTENT,
        cards: [MIRA],
        model: MODEL,
      });

      expect(drift.driftError()).toBe(false);
      expect(drift.driftFlags()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'full canon check flags the same contradiction',
    async () => {
      const { drift, settings, stories } = await setup();
      settings.setCanonCheck(true);
      const storyId = stories.activeStoryId();
      drift.activeStoryId.set(storyId);

      await drift.runCanonCheck({
        storyId,
        draft: CONTRADICTION,
        cards: [MIRA],
        model: MODEL,
      });

      expect(drift.driftError()).toBe(false);
      expect(drift.driftFlags().length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'extraction suggests new named entities from a finalized chapter',
    async () => {
      const { extraction, settings } = await setup();
      settings.setExtraction(true);

      await extraction.onChapterFinalized({
        chapterId: 'ch-eval',
        body: NEW_ENTITIES,
        model: MODEL,
      });

      expect(extraction.extractionError()).toBe(false);
      const names = extraction.suggestions().map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('holloway'))).toBe(true);
    },
    TIMEOUT,
  );
});
