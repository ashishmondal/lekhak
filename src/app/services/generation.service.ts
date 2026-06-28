import { Service, inject, signal } from '@angular/core';

import { AiError } from '../ai/ai-error';
import { DEFAULT_MODEL, DEFAULT_TEMPERATURE } from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { ContextBuilder, type ContextInput } from '../context/context-builder';
import type { Card } from '../models/domain';
import { BackgroundQueue } from './background-queue';
import { SynopsisService } from './synopsis.service';

export interface GenerateRunOpts {
  model?: string;
  temperature?: number;
}

/**
 * Orchestrates a single generation run: build the prompt context, stream the
 * provider's deltas, and own the lifecycle (single-flight, abort, error
 * mapping). The editor consumes the yielded chunks; this service holds the
 * status signals so the UI can render streaming/error/trim state.
 *
 * Single-flight: starting a new run aborts the previous one. Aborted runs are
 * silent (partial text is kept by the caller); other failures land in `error`.
 */
@Service()
export class GenerationService {
  private readonly provider = inject(AI_PROVIDER);
  private readonly contextBuilder = inject(ContextBuilder);
  private readonly synopsis = inject(SynopsisService);
  private readonly queue = inject(BackgroundQueue);

  private controller: AbortController | null = null;

  readonly streaming = signal(false);
  readonly error = signal<AiError | null>(null);
  readonly trimmedNote = signal<string | null>(null);
  /** Cards the last run actually sent to the model (for the resolved-cards chip). */
  readonly usedCards = signal<Card[]>([]);

  /** Stream the continuation for `input`. Yields text deltas in order. */
  async *generate(
    input: ContextInput,
    opts: GenerateRunOpts = {},
  ): AsyncGenerator<string> {
    // Single-flight: supersede any in-flight run.
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    this.error.set(null);
    this.streaming.set(true);

    // Foreground wins the single BYOK key: pause background advisory work for
    // the life of this stream so we never race it into a 429.
    const releaseForeground = this.queue.beginForeground();

    try {
      const { messages, usedCards, trimmedNote, droppedChapterIds } =
        this.contextBuilder.build(input);
      this.trimmedNote.set(trimmedNote);
      this.usedCards.set(usedCards);

      // Lazy synopsis: if the budget trimmed chapters, refresh the rolling
      // recap in the background. Fire-and-forget — this run never waits on it.
      if (droppedChapterIds.length > 0) {
        const dropped = input.chapters.filter((c) =>
          droppedChapterIds.includes(c.id),
        );
        this.synopsis.onContextBuilt(input.story.id, dropped, {
          model: opts.model,
        });
      }

      const stream = this.provider.generate(messages, {
        model: opts.model ?? DEFAULT_MODEL,
        temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
        storyName: input.story.title,
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          return;
        }
        yield chunk;
      }
    } catch (err) {
      const aiError = AiError.fromThrown(err, controller.signal);
      // Abort is a user action, not an error: keep partial text, stay quiet.
      if (aiError.kind !== 'aborted') {
        this.error.set(aiError);
      }
    } finally {
      // Only the current run owns the status; a superseded run must not reset it.
      if (this.controller === controller) {
        this.streaming.set(false);
        this.controller = null;
      }
      releaseForeground();
    }
  }

  /** Abort the in-flight run, if any. Streamed text already yielded is kept. */
  stop(): void {
    this.controller?.abort();
  }
}
