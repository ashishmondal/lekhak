import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type { AiErrorKind } from '../ai/ai-error';
import type { Chapter, Story } from '../models/domain';
import type { ContextInput } from '../context/context-builder';
import { GenerationService } from '../services/generation.service';
import { Autosave } from '../services/autosave';
import { SettingsService } from '../services/settings.service';
import { StorageService } from '../services/storage.service';
import { saveStateLabel } from '../services/save-state';
import { WorldStore } from '../world/world.store';

const ERROR_COPY: Record<AiErrorKind, string> = {
  auth: 'Check your API key in Settings.',
  rate_limit: 'Rate limited — try again in a moment.',
  network: 'Generation interrupted. Check your connection and retry.',
  overflow: 'That passage was too long to send. Trim the story and retry.',
  aborted: '',
  unknown: 'Something went wrong. Try again.',
};

/** How much of the tail feeds the relevance pass for card selection. */
const RECENT_TAIL_CHARS = 2000;
/** Treat the story box as "at bottom" within this many pixels. */
const SCROLL_EPSILON = 20;

/**
 * Two-pane co-writer. The big story box holds the durable chapter body; the
 * small "what happens next" box is a transient steering line. **Write next**
 * streams the continuation onto the end of the story box. Token appends are
 * rAF-batched, and the box only auto-scrolls when the author is already at the
 * bottom (so scrolling back to edit is never yanked away).
 */
@Component({
  selector: 'app-editor',
  imports: [RouterLink],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.css',
})
export class EditorComponent implements OnInit {
  protected readonly gen = inject(GenerationService);
  protected readonly autosave = inject(Autosave);
  protected readonly world = inject(WorldStore);
  private readonly storage = inject(StorageService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly storyText = signal('');
  protected readonly nextBeat = signal('');
  /** Faded ghost of the last beat that was sent. */
  protected readonly lastBeat = signal('');

  protected readonly errorMessage = computed(() => {
    const err = this.gen.error();
    return err ? ERROR_COPY[err.kind] : '';
  });

  /** True when a write hit the browser storage quota; shown as a banner. */
  protected readonly storageFull = computed(() => this.storage.quotaExceeded());

  protected readonly saveLabel = computed(() =>
    saveStateLabel(this.autosave.state()),
  );

  /** Names of the cards the last run actually sent, for the resolved-cards chip. */
  protected readonly usedCardNames = computed(() =>
    this.gen.usedCards().map((c) => c.name),
  );

  private readonly storyBox =
    viewChild<ElementRef<HTMLTextAreaElement>>('storyBox');

  // Single-draft scaffold persisted to IndexedDB. World/story/era selection and
  // multiple drafts arrive with T7; this keeps the body durable across reloads.
  private readonly story: Story = {
    id: 'default-story',
    worldId: 'default-world',
    eraId: '',
    title: 'Untitled',
    updatedAt: 0,
  };
  private readonly chapterId = 'default-chapter';
  private pending = '';
  private rafId: number | null = null;
  private firstChunk = true;
  /** Whether the story box should follow new tokens (author is at the bottom). */
  private stick = true;

  async ngOnInit(): Promise<void> {
    // Register teardown synchronously, before any await, so it never lands on
    // an already-destroyed view.
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        void this.autosave.flush();
      }
    };
    const onUnload = () => {
      void this.autosave.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      void this.autosave.flush(); // route change / teardown
    });

    const existing = await this.storage.getChapter(this.chapterId);
    if (existing) {
      this.storyText.set(existing.body);
    }
    await this.world.init();
  }

  protected onStoryInput(value: string): void {
    this.storyText.set(value);
    this.markDirty();
  }

  protected onStoryScroll(box: HTMLTextAreaElement): void {
    this.stick =
      box.scrollTop + box.clientHeight >= box.scrollHeight - SCROLL_EPSILON;
  }

  protected onBeatKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.writeNext();
    }
  }

  protected stop(): void {
    this.gen.stop();
    void this.autosave.flush(); // abort is a hard flush point
  }

  protected async writeNext(): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    // BYOK guard: no key means nothing to send. Send the author to Settings.
    if (!this.settings.hasKey()) {
      void this.router.navigate(['/settings']);
      return;
    }
    // Persist any unsaved typing before we send it as context.
    await this.autosave.flush();

    const beat = this.nextBeat().trim();
    const body = this.storyText();

    const worldId = this.world.world()?.id ?? this.story.worldId;
    const eraId = this.world.currentEraId();
    const story: Story = { ...this.story, worldId, eraId };

    const chapters: Chapter[] = [
      {
        id: this.chapterId,
        storyId: story.id,
        order: 0,
        title: story.title,
        body,
        updatedAt: 0,
      },
    ];

    const input: ContextInput = {
      story,
      chapters,
      cards: this.world.cards(),
      nextBeat: beat || undefined,
      recentText: `${body.slice(-RECENT_TAIL_CHARS)} ${beat}`,
    };

    this.firstChunk = true;
    this.stick = true;
    try {
      for await (const chunk of this.gen.generate(input, {
        model: this.settings.model(),
      })) {
        this.append(chunk);
      }
    } finally {
      this.flushNow();
      if (beat) {
        this.lastBeat.set(beat);
        this.nextBeat.set('');
      }
      void this.autosave.flush(); // stream-complete is a hard flush point
    }
  }

  private append(chunk: string): void {
    if (this.firstChunk) {
      this.firstChunk = false;
      const body = this.storyText();
      if (body && !/\s$/.test(body)) {
        this.pending += '\n\n';
      }
    }
    this.pending += chunk;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) {
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flush();
    });
  }

  private flushNow(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.pending) {
      return;
    }
    const text = this.pending;
    this.pending = '';
    this.storyText.update((s) => s + text);
    this.markDirty();

    if (this.stick) {
      const box = this.storyBox()?.nativeElement;
      if (box) {
        // Pin after the bound value renders on the next frame.
        requestAnimationFrame(() => {
          box.scrollTop = box.scrollHeight;
        });
      }
    }
  }

  /** Queue a debounced persist of the current story body. */
  private markDirty(): void {
    this.autosave.schedule(() => this.persist());
  }

  private persist(): Promise<void> {
    const chapter: Chapter = {
      id: this.chapterId,
      storyId: this.story.id,
      order: 0,
      title: this.story.title,
      body: this.storyText(),
      updatedAt: Date.now(),
    };
    return this.storage.putChapter(chapter);
  }
}
