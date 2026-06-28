import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AiError } from '../ai/ai-error';
import type { AiProvider, ChatMessage, GenerateOpts } from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { FakeProvider } from '../ai/fake-provider';
import type { Chapter } from '../models/domain';
import { StoryStore } from '../story/story.store';
import { SynopsisService } from './synopsis.service';

function chapter(over: Partial<Chapter> = {}): Chapter {
  return { id: 'c0', storyId: 's1', order: 0, title: '', body: 'Body.', updatedAt: 1, ...over };
}

/** Lets a test queue and release each generate() call deterministically. */
class GatedProvider implements AiProvider {
  readonly id = 'gated';
  readonly calls: {
    messages: ChatMessage[];
    signal?: AbortSignal;
    release: (chunks: string[]) => void;
  }[] = [];

  async *generate(messages: ChatMessage[], opts: GenerateOpts): AsyncIterable<string> {
    const chunks = await new Promise<string[]>((release) => {
      this.calls.push({ messages, signal: opts.signal, release });
    });
    for (const c of chunks) {
      if (opts.signal?.aborted) {
        throw new AiError('aborted', 'stopped');
      }
      yield c;
    }
  }
  async testConnection(): Promise<boolean> {
    return true;
  }
}

/** Records setSynopsis calls so tests can assert what got persisted. */
class FakeStore {
  readonly saved: { storyId: string; synopsis: string }[] = [];
  async setSynopsis(storyId: string, synopsis: string): Promise<void> {
    this.saved.push({ storyId, synopsis });
  }
}

function configure(provider: AiProvider): { svc: SynopsisService; store: FakeStore } {
  const store = new FakeStore();
  TestBed.configureTestingModule({
    providers: [
      { provide: AI_PROVIDER, useValue: provider },
      { provide: StoryStore, useValue: store },
      SynopsisService,
    ],
  });
  return { svc: TestBed.inject(SynopsisService), store: store as unknown as FakeStore };
}

/** Flush pending microtasks + timers so background runs settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SynopsisService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('does nothing when no chapters were dropped', async () => {
    const provider = new GatedProvider();
    const { svc, store } = configure(provider);
    svc.onContextBuilt('s1', []);
    await tick();
    expect(provider.calls).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });

  it('summarizes dropped chapters and persists the synopsis', async () => {
    const provider = new GatedProvider();
    const { svc, store } = configure(provider);
    svc.onContextBuilt('s1', [chapter({ id: 'c0', body: 'Mara fled.' })]);
    expect(provider.calls).toHaveLength(1);
    provider.calls[0].release(['Mara ', 'fled the ', 'capital.']);
    await tick();
    expect(store.saved).toEqual([{ storyId: 's1', synopsis: 'Mara fled the capital.' }]);
  });

  it('returns synchronously without blocking on the summary', () => {
    const provider = new GatedProvider();
    const { svc } = configure(provider);
    // The call returns even though the provider has not produced anything yet.
    svc.onContextBuilt('s1', [chapter()]);
    expect(provider.calls).toHaveLength(1); // queued, not yet resolved
  });

  it('coalesces an identical dropped set into a single in-flight run', async () => {
    const provider = new GatedProvider();
    const { svc, store } = configure(provider);
    const dropped = [chapter({ id: 'c0', updatedAt: 5 })];
    svc.onContextBuilt('s1', dropped);
    svc.onContextBuilt('s1', dropped); // same signature while first is in flight
    expect(provider.calls).toHaveLength(1); // no duplicate run
    provider.calls[0].release(['summary']);
    await tick();
    expect(store.saved).toHaveLength(1);
  });

  it('skips re-summarizing a dropped set already completed', async () => {
    const provider = new GatedProvider();
    const { svc, store } = configure(provider);
    const dropped = [chapter({ id: 'c0', updatedAt: 5 })];
    svc.onContextBuilt('s1', dropped);
    provider.calls[0].release(['done']);
    await tick();
    expect(store.saved).toHaveLength(1);

    svc.onContextBuilt('s1', dropped); // identical set, already persisted
    await tick();
    expect(provider.calls).toHaveLength(1); // no new run
    expect(store.saved).toHaveLength(1);
  });

  it('supersedes an in-flight run when the dropped set changes', async () => {
    const provider = new GatedProvider();
    const { svc, store } = configure(provider);
    svc.onContextBuilt('s1', [chapter({ id: 'c0', updatedAt: 1 })]);
    // A second, larger drop set arrives before the first finishes.
    svc.onContextBuilt('s1', [
      chapter({ id: 'c0', updatedAt: 1 }),
      chapter({ id: 'c1', order: 1, updatedAt: 1 }),
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].signal?.aborted).toBe(true); // first was superseded

    provider.calls[0].release(['stale']); // resolves but is aborted → discarded
    provider.calls[1].release(['fresh recap']);
    await tick();

    expect(store.saved).toEqual([{ storyId: 's1', synopsis: 'fresh recap' }]);
  });

  it('stays silent and persists nothing when the provider fails', async () => {
    const provider = new FakeProvider({
      chunks: [],
      error: new AiError('network', 'down'),
      errorAfter: 0,
    });
    const { svc, store } = configure(provider);
    // Must not throw out of the fire-and-forget call.
    svc.onContextBuilt('s1', [chapter()]);
    await tick();
    expect(store.saved).toHaveLength(0);
  });
});
