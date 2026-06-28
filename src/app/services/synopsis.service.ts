import { Service, inject } from '@angular/core';

import { AI_PROVIDER } from '../ai/ai-provider.token';
import { DEFAULT_MODEL, type ChatMessage } from '../ai/ai-provider';
import { collect } from '../ai/completion';
import type { Chapter } from '../models/domain';
import { StoryStore } from '../story/story.store';

/** Low temperature: a synopsis is a factual recap, not creative prose. */
export const SYNOPSIS_TEMPERATURE = 0.3;

const SYNOPSIS_SYSTEM = [
  'You are a story editor producing a "story so far" recap.',
  'Summarize the earlier chapters into a tight continuity brief that preserves',
  'plot events, decisions, character actions, relationships, and revealed facts',
  'a writer needs to continue consistently.',
  'Write one or two short paragraphs of plain prose.',
  'Do not invent details, add a character list, use bullet points, or include',
  'headings — return only the recap text.',
].join(' ');

export interface SynopsisRunOpts {
  /** Model to summarize with; falls back to the provider default. */
  model?: string;
}

interface InFlight {
  controller: AbortController;
  signature: string;
}

/**
 * Keeps each story's rolling synopsis current — lazily and in the background.
 *
 * The synopsis only matters once the budget starts dropping chapters, so this
 * service does nothing until {@link onContextBuilt} is told a generation trimmed
 * some. It then summarizes ONLY the dropped chapters and persists the result on
 * the Story (via {@link StoryStore.setSynopsis}); the next generation feeds that
 * text back into the prompt as the STORY SO FAR block.
 *
 * Guarantees:
 *  - Non-blocking: callers fire-and-forget; the generation that triggered the
 *    refresh never waits on it (cold start in particular never blocks).
 *  - Single-flight per story: at most one summary runs per story at a time.
 *  - Trailing-edit coalescing: if the dropped set changes mid-run, the stale
 *    run is aborted and superseded; an unchanged set is never re-summarized.
 *  - Silent: a background failure leaves the prior synopsis untouched and never
 *    surfaces to the author.
 */
@Service()
export class SynopsisService {
  private readonly provider = inject(AI_PROVIDER);
  private readonly stories = inject(StoryStore);

  /** In-flight summary per story, with the dropped-set signature it covers. */
  private readonly running = new Map<string, InFlight>();
  /** Last signature successfully summarized per story (skip redundant work). */
  private readonly completed = new Map<string, string>();

  /**
   * React to a freshly-built context. If the budget dropped chapters, refresh
   * the story's synopsis in the background. Returns immediately.
   */
  onContextBuilt(
    storyId: string,
    droppedChapters: Chapter[],
    opts: SynopsisRunOpts = {},
  ): void {
    if (!storyId || droppedChapters.length === 0) {
      return; // nothing trimmed → no synopsis needed
    }
    const signature = signatureOf(droppedChapters);
    const current = this.running.get(storyId);
    if (current?.signature === signature) {
      return; // identical set already being summarized
    }
    if (!current && this.completed.get(storyId) === signature) {
      return; // identical set already summarized and persisted
    }
    // A newer (or first) dropped set wins: supersede any stale in-flight run.
    current?.controller.abort();
    const controller = new AbortController();
    this.running.set(storyId, { controller, signature });
    void this.run(storyId, droppedChapters, signature, controller, opts);
  }

  private async run(
    storyId: string,
    droppedChapters: Chapter[],
    signature: string,
    controller: AbortController,
    opts: SynopsisRunOpts,
  ): Promise<void> {
    try {
      const summary = (
        await collect(this.provider, synopsisPrompt(droppedChapters), {
          model: opts.model ?? DEFAULT_MODEL,
          temperature: SYNOPSIS_TEMPERATURE,
          signal: controller.signal,
        })
      ).trim();
      if (controller.signal.aborted || summary === '') {
        return; // superseded, or the model returned nothing usable
      }
      await this.stories.setSynopsis(storyId, summary);
      this.completed.set(storyId, signature);
    } catch {
      // Background housekeeping: any failure (network, auth, abort) just leaves
      // the previous synopsis in place. Never shown to the author.
    } finally {
      // Only clear if a superseding run hasn't already replaced this entry.
      if (this.running.get(storyId)?.controller === controller) {
        this.running.delete(storyId);
      }
    }
  }
}

/** Identity of a dropped set: ids + last-edit stamps, so an edit re-triggers. */
function signatureOf(chapters: Chapter[]): string {
  return chapters
    .map((c) => `${c.id}:${c.updatedAt}`)
    .sort()
    .join('|');
}

/** Build the summarization prompt from the dropped chapters (oldest first). */
function synopsisPrompt(chapters: Chapter[]): ChatMessage[] {
  const body = [...chapters]
    .sort((a, b) => a.order - b.order)
    .map((c) => `## Chapter ${c.order + 1}\n${c.body.trim()}`)
    .join('\n\n');
  return [
    { role: 'system', content: SYNOPSIS_SYSTEM },
    {
      role: 'user',
      content: `${body}\n\nWrite the "story so far" recap of the chapters above.`,
    },
  ];
}
