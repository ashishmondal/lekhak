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
import type { ContextInput } from '../context/context-builder';
import { GenerationService } from '../services/generation.service';
import { Autosave } from '../services/autosave';
import { SettingsService } from '../services/settings.service';
import { saveStateLabel } from '../services/save-state';
import { MAX_CHAPTERS, StorageService } from '../services/storage.service';
import { StoryStore } from '../story/story.store';
import { WorldStore } from '../world/world.store';
import { ThemeToggleComponent } from '../theme/theme-toggle.component';

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
  imports: [RouterLink, ThemeToggleComponent],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.css',
})
export class EditorComponent implements OnInit {
  protected readonly gen = inject(GenerationService);
  protected readonly autosave = inject(Autosave);
  protected readonly world = inject(WorldStore);
  protected readonly stories = inject(StoryStore);
  private readonly storage = inject(StorageService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly storyText = signal('');
  protected readonly nextBeat = signal('');
  /** Faded ghost of the last beat that was sent. */
  protected readonly lastBeat = signal('');
  /** Whether the inline "new story" title form is open. */
  protected readonly showNewStory = signal(false);
  protected readonly newStoryTitle = signal('');
  /** Era chosen for the story being created. Fixed once the story exists. */
  protected readonly newStoryEraId = signal('');
  /** The per-story chapter cap, surfaced for the New chapter control. */
  protected readonly maxChapters = MAX_CHAPTERS;

  /** Name of the active story's locked era, shown while writing. */
  protected readonly activeEraName = computed(() => {
    const eraId = this.stories.activeStory()?.eraId;
    return this.world.eras().find((e) => e.id === eraId)?.name ?? '';
  });

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

  /** The chapter/story overflow menu, closed on outside-click and Escape. */
  private readonly moreMenu =
    viewChild<ElementRef<HTMLDetailsElement>>('moreMenu');

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

    // Dismiss the overflow menu on an outside click or Escape (native
    // <details> stays open otherwise).
    const closeMenu = (focusSummary = false) => {
      const el = this.moreMenu()?.nativeElement;
      if (!el?.open) {
        return;
      }
      el.open = false;
      if (focusSummary) {
        el.querySelector('summary')?.focus();
      }
    };
    const onDocClick = (e: MouseEvent) => {
      const el = this.moreMenu()?.nativeElement;
      if (el?.open && !el.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu(true);
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeydown);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    });

    this.initialized = this.loadInitial();
    await this.initialized;
  }

  /**
   * Resolves once the initial world + story library has loaded. Exposed so
   * tests can await the async bootstrap that `ngOnInit` kicks off.
   */
  protected initialized: Promise<void> = Promise.resolve();

  /** Bootstrap the world, then the story library, then open the active draft. */
  private async loadInitial(): Promise<void> {
    await this.world.init();
    await this.stories.init(
      this.world.world()?.id ?? '',
      this.world.currentEraId(),
    );
    this.loadActiveBody();
  }

  /** Pull the active chapter's persisted body into the editing buffer. */
  private loadActiveBody(): void {
    this.storyText.set(this.stories.activeChapter()?.body ?? '');
    this.firstChunk = true;
    this.stick = true;
  }

  /** Switch stories, persisting the open chapter first. */
  protected async onSelectStory(id: string): Promise<void> {
    if (this.gen.streaming() || id === this.stories.activeStoryId()) {
      return;
    }
    await this.autosave.flush(); // save the chapter we're leaving
    await this.stories.selectStory(id);
    this.loadActiveBody();
  }

  /** Page one chapter earlier (-1) or later (+1), persisting first. */
  protected async stepChapter(direction: -1 | 1): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    await this.autosave.flush();
    this.stories.stepChapter(direction);
    this.loadActiveBody();
  }

  /** Append a new chapter to the active story and open it. */
  protected async newChapter(): Promise<void> {
    if (this.gen.streaming() || this.stories.atChapterCap()) {
      return;
    }
    await this.autosave.flush();
    await this.stories.createChapter();
    this.loadActiveBody();
  }

  /** Open the new-story form, seeding the era with the current world era. */
  protected openNewStory(): void {
    this.newStoryEraId.set(
      this.world.currentEraId() || this.world.eras()[0]?.id || '',
    );
    this.showNewStory.set(true);
  }

  /** Create a new story from the inline title form and open its first chapter. */
  protected async createStory(): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    await this.autosave.flush();
    await this.stories.createStory(
      this.newStoryTitle(),
      this.world.world()?.id ?? '',
      this.newStoryEraId() || this.world.currentEraId(),
    );
    this.newStoryTitle.set('');
    this.showNewStory.set(false);
    this.loadActiveBody();
  }

  /** Reorder the active chapter one slot earlier (-1) or later (+1). */
  protected async reorderChapter(direction: -1 | 1): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    await this.autosave.flush(); // fold the live body in before rewriting the record
    await this.stories.moveChapter(this.stories.activeChapterId(), direction);
    this.loadActiveBody();
  }

  /** Delete the active chapter after confirming (destructive, no undo). */
  protected async deleteActiveChapter(): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    const label = `Chapter ${this.stories.activeChapterNumber()}`;
    if (!this.confirm(`Delete ${label}? This can't be undone.`)) {
      return;
    }
    await this.autosave.flush();
    await this.stories.deleteChapter(this.stories.activeChapterId());
    this.loadActiveBody();
  }

  /** Delete the active story and all its chapters after confirming. */
  protected async deleteActiveStory(): Promise<void> {
    if (this.gen.streaming()) {
      return;
    }
    const title = this.stories.activeStory()?.title ?? 'this story';
    if (!this.confirm(`Delete "${title}" and all its chapters? This can't be undone.`)) {
      return;
    }
    await this.autosave.flush();
    await this.stories.deleteStory(this.stories.activeStoryId());
    this.loadActiveBody();
  }

  /** Native confirm, wrapped so tests can stub the destructive gate. */
  protected confirm(message: string): boolean {
    return globalThis.confirm?.(message) ?? false;
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
    // The engine continues the highest-order chapter, so Write next only runs on
    // the latest chapter. Earlier chapters are editable text, not continuable.
    if (!this.stories.isLatestActive()) {
      return;
    }
    // BYOK guard: no key means nothing to send. Send the author to Settings.
    if (!this.settings.hasKey()) {
      void this.router.navigate(['/settings']);
      return;
    }
    const story = this.stories.activeStory();
    if (!story) {
      return;
    }
    // Persist any unsaved typing before we send it as context.
    await this.autosave.flush();

    const beat = this.nextBeat().trim();
    const body = this.storyText();

    // Feed the engine the story's real chapters. The active (latest) chapter
    // carries the live, possibly-unsaved body so the continuation is current.
    const activeId = this.stories.activeChapterId();
    const chapters = this.stories
      .chapters()
      .map((c) => (c.id === activeId ? { ...c, body } : c));

    const input: ContextInput = {
      story,
      chapters,
      cards: this.world.cards(),
      nextBeat: beat || undefined,
      recentText: `${body.slice(-RECENT_TAIL_CHARS)} ${beat}`,
      systemPrompt: this.settings.systemPrompt(),
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
    return this.stories.saveActiveBody(this.storyText());
  }
}
