import { Service, signal } from '@angular/core';

import type { SaveState } from './save-state';

/** Quiet period after the last edit before a debounced write fires. */
export const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * A coalescing, debounced writer. The editor calls {@link schedule} on every
 * keystroke and streamed-token flush; rapid edits collapse into a single write
 * after the quiet period. Hard flush points (pre-generate, abort,
 * stream-complete, tab-hide, route change) call {@link flush} to persist
 * immediately and await the write.
 *
 * Writes are serialized through one chain so an in-flight write never overlaps
 * the next, and the freshest pending snapshot always wins. The {@link state}
 * signal drives the status chip.
 */
@Service()
export class Autosave {
  readonly state = signal<SaveState>('saved');

  private pending: (() => Promise<void>) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private debounceMs = AUTOSAVE_DEBOUNCE_MS;

  /** Override the debounce (used by tests to avoid real waits). */
  configure(debounceMs: number): void {
    this.debounceMs = debounceMs;
  }

  /** Note the latest write. Only the last task in a burst actually runs. */
  schedule(task: () => Promise<void>): void {
    this.pending = task;
    this.state.set('saving');
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.debounceMs);
  }

  /** Persist any pending write now and resolve once it has been written. */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.drain();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drain(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const task = this.pending;
      if (!task) {
        return;
      }
      this.pending = null;
      this.state.set('saving');
      try {
        await task();
        // A newer edit may have landed mid-write; stay "saving" until it drains.
        if (this.pending === null) {
          this.state.set('saved');
        }
      } catch {
        this.state.set('failed');
      }
    });
    return this.chain;
  }
}
