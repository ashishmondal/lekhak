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
import {
  DEFAULT_STYLE,
  WRITING_STYLES,
  buildSystemPrompt,
  isWritingStyleId,
  type WritingStyleId,
} from '../ai/writing-style';
import { resolveCard, type ContextInput } from '../context/context-builder';
import type { Card } from '../models/domain';
import { findActiveMention, rankCharacters } from './mention';
import { GenerationService } from '../services/generation.service';
import { CanonCheckService } from '../services/canon-check.service';
import {
  ExtractionService,
  type ExtractionSuggestion,
} from '../services/extraction.service';
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
  protected readonly drift = inject(CanonCheckService);
  protected readonly extraction = inject(ExtractionService);
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
  /** Style chosen for the story being created. Locked once the story exists. */
  protected readonly newStoryStyleId = signal<WritingStyleId>(DEFAULT_STYLE);
  /** Writing styles offered in the new-story form. */
  protected readonly styles = WRITING_STYLES;
  /** The per-story chapter cap, surfaced for the New chapter control. */
  protected readonly maxChapters = MAX_CHAPTERS;

  /** Name of the active story's locked era, shown while writing. */
  protected readonly activeEraName = computed(() => {
    const eraId = this.stories.activeStory()?.eraId;
    return this.world.eras().find((e) => e.id === eraId)?.name ?? '';
  });

  /** Label of the active story's locked writing style, shown while writing. */
  protected readonly activeStyleLabel = computed(() => {
    const raw = this.stories.activeStory()?.styleId;
    // Legacy stories may carry a retired id; resolve those to the default.
    const styleId = raw && isWritingStyleId(raw) ? raw : DEFAULT_STYLE;
    return WRITING_STYLES.find((s) => s.id === styleId)?.label ?? '';
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

  /** Whether the inline `@`-mention character picker is open. */
  protected readonly mentionOpen = signal(false);
  /** Era-resolved character cards offered by the open mention picker. */
  protected readonly mentionItems = signal<Card[]>([]);
  /** Highlighted row in the mention picker (keyboard + hover). */
  protected readonly mentionIndex = signal(0);
  /** Absolute position of the mention picker, anchored to the caret. */
  protected readonly mentionStyle = signal<{ top: string; left: string }>({
    top: '0',
    left: '0',
  });
  /** Index of the `@` that opened the current picker, for replacement. */
  private mentionStart = -1;
  /** Which textarea the open picker is editing, so insertion targets it. */
  private mentionField: 'story' | 'beat' | null = null;

  private readonly storyBox =
    viewChild<ElementRef<HTMLTextAreaElement>>('storyBox');
  private readonly beatBox =
    viewChild<ElementRef<HTMLTextAreaElement>>('beatBox');

  /** The chapter/story overflow menu, closed on outside-click and Escape. */
  private readonly moreMenu =
    viewChild<ElementRef<HTMLDetailsElement>>('moreMenu');
  /** The drift-flags popover; same outside-click/Escape behavior. */
  private readonly driftMenu =
    viewChild<ElementRef<HTMLDetailsElement>>('driftMenu');
  /** The extraction-suggestions tray; same outside-click/Escape behavior. */
  private readonly extractMenu =
    viewChild<ElementRef<HTMLDetailsElement>>('extractMenu');

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

    // Dismiss any open popover (overflow menu, drift flags, extraction tray)
    // on an outside click or Escape (native <details> stays open otherwise).
    const menus = (): HTMLDetailsElement[] =>
      [this.moreMenu(), this.driftMenu(), this.extractMenu()]
        .map((m) => m?.nativeElement)
        .filter((el): el is HTMLDetailsElement => !!el);
    const onDocClick = (e: MouseEvent) => {
      for (const el of menus()) {
        if (el.open && !el.contains(e.target as Node)) {
          el.open = false;
        }
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }
      for (const el of menus()) {
        if (el.open) {
          el.open = false;
          el.querySelector('summary')?.focus();
        }
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
    this.drift.activeStoryId.set(this.stories.activeStoryId());
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
    // The chapter we're leaving is now finalized: mine it for new world cards
    // (opt-in, background — a no-op when extraction is off). Fire-and-forget.
    void this.extraction.onChapterFinalized({
      chapterId: this.stories.activeChapterId(),
      body: this.storyText(),
      model: this.settings.model(),
    });
    await this.stories.createChapter();
    this.loadActiveBody();
  }

  /** Era-resolve the world cards for the active story's locked era. */
  private resolvedCards(): Card[] {
    const eraId = this.stories.activeStory()?.eraId ?? '';
    return this.world.cards().map((card) => resolveCard(card, eraId));
  }

  /**
   * Nudge the opt-in drift check after a draft edit. A no-op when the toggle is
   * off; otherwise debounced and gated inside the service.
   */
  private scheduleDriftCheck(): void {
    const story = this.stories.activeStory();
    if (!story) {
      return;
    }
    this.drift.noteDraftChanged({
      storyId: story.id,
      draft: this.storyText(),
      cards: this.resolvedCards(),
      synopsis: story.synopsis,
      model: this.settings.model(),
    });
  }

  /** Dismiss a single continuity flag (remembered per story). */
  protected async dismissDrift(flagId: string): Promise<void> {
    await this.drift.dismissDrift(flagId);
  }

  /** Accept an extracted suggestion, creating a World card. */
  protected async acceptSuggestion(s: ExtractionSuggestion): Promise<void> {
    await this.extraction.accept(s);
  }

  /** Dismiss an extracted suggestion (remembered world-wide, never re-asked). */
  protected async dismissSuggestion(s: ExtractionSuggestion): Promise<void> {
    await this.extraction.dismiss(s);
  }

  /** Open the new-story form, seeding the era with the current world era. */
  protected openNewStory(): void {
    this.newStoryEraId.set(
      this.world.currentEraId() || this.world.eras()[0]?.id || '',
    );
    // Seed the style with the settings default; the author can change it here,
    // but it locks once the story is created.
    this.newStoryStyleId.set(this.settings.style());
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
      this.newStoryStyleId(),
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

  protected onStoryInput(box: HTMLTextAreaElement): void {
    this.storyText.set(box.value);
    this.markDirty();
    this.updateMention('story', box);
    this.scheduleDriftCheck();
  }

  protected onBeatInput(box: HTMLTextAreaElement): void {
    this.nextBeat.set(box.value);
    this.updateMention('beat', box);
  }

  protected onStoryScroll(box: HTMLTextAreaElement): void {
    this.stick =
      box.scrollTop + box.clientHeight >= box.scrollHeight - SCROLL_EPSILON;
    if (this.mentionOpen()) {
      this.positionMention(box);
    }
  }

  /** Reposition the picker when the (short) beat box scrolls under the caret. */
  protected onBeatScroll(box: HTMLTextAreaElement): void {
    if (this.mentionOpen()) {
      this.positionMention(box);
    }
  }

  /**
   * Refresh the `@`-mention picker against the caret of `box`. Opens it when an
   * active mention resolves to one or more characters, otherwise closes it.
   * Cards are era-resolved first so suggestions (and the inserted name) match
   * the story's locked era. Works for both the story box and the beat box.
   */
  private updateMention(field: 'story' | 'beat', box: HTMLTextAreaElement): void {
    const caret = box.selectionStart ?? box.value.length;
    const mention = findActiveMention(box.value, caret);
    if (!mention) {
      this.closeMention();
      return;
    }
    const eraId = this.stories.activeStory()?.eraId ?? '';
    const resolved = this.world.cards().map((card) => resolveCard(card, eraId));
    const items = rankCharacters(resolved, mention.query);
    if (!items.length) {
      this.closeMention();
      return;
    }
    this.mentionField = field;
    this.mentionStart = mention.start;
    this.mentionItems.set(items);
    this.mentionIndex.set(0);
    this.mentionOpen.set(true);
    this.positionMention(box);
  }

  /**
   * Anchor the picker to the caret in viewport space (the two textareas live in
   * different containers, so the menu is `position: fixed`). Flips above the
   * line when there isn't room below — important for the bottom beat box.
   */
  private positionMention(box: HTMLTextAreaElement): void {
    const coords = caretCoordinates(box, this.mentionStart);
    const rect = box.getBoundingClientRect();
    const left = rect.left + coords.left - box.scrollLeft;
    const lineTop = rect.top + coords.top - box.scrollTop;
    const estHeight = Math.min(this.mentionItems().length, 6) * 40 + 8;

    let top = lineTop + coords.height;
    if (top + estHeight > window.innerHeight && lineTop - estHeight > 0) {
      top = lineTop - estHeight; // not enough room below — open upward
    }
    this.mentionStyle.set({ top: `${top}px`, left: `${left}px` });
  }

  protected closeMention(): void {
    if (this.mentionOpen()) {
      this.mentionOpen.set(false);
    }
    this.mentionStart = -1;
    this.mentionField = null;
  }

  /**
   * Keyboard control for the open picker: arrows move the highlight, Enter/Tab
   * accept the canonical name, Escape dismisses. No-ops (and lets the key pass
   * through) when the picker is closed, so newlines and beat-submit still work.
   */
  protected onMentionKeydown(event: KeyboardEvent): void {
    if (!this.mentionOpen()) {
      return;
    }
    const items = this.mentionItems();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.mentionIndex.update((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.mentionIndex.update((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        this.applyMention(items[this.mentionIndex()]);
        break;
      case 'Escape':
        event.preventDefault();
        this.closeMention();
        break;
    }
  }

  /**
   * Replace the typed `@query` with the card's canonical, era-resolved name —
   * this is what guarantees a spelling the relevance pass will always match.
   * Targets whichever field opened the picker, leaves a trailing space, and
   * restores the caret after the inserted name.
   */
  protected applyMention(card: Card): void {
    const field = this.mentionField;
    if (!field || this.mentionStart < 0) {
      return;
    }
    const target = field === 'story' ? this.storyText : this.nextBeat;
    const box = this.boxFor(field);
    const text = target();
    const caret = box?.selectionStart ?? text.length;

    const before = text.slice(0, this.mentionStart);
    const after = text.slice(caret);
    const needsSpace = !after.startsWith(' ');
    const next = `${before}${card.name}${needsSpace ? ' ' : ''}${after}`;
    const caretPos = before.length + card.name.length + (needsSpace ? 1 : 0);

    target.set(next);
    if (field === 'story') {
      this.markDirty();
    }
    this.closeMention();

    // The textarea value is one-way bound; restore focus + caret after Angular
    // flushes the new value on the next frame.
    requestAnimationFrame(() => {
      const el = this.boxFor(field);
      if (el) {
        el.focus();
        el.setSelectionRange(caretPos, caretPos);
      }
    });
  }

  /** Native textarea backing the given mention field, if rendered. */
  private boxFor(field: 'story' | 'beat'): HTMLTextAreaElement | undefined {
    return field === 'story'
      ? this.storyBox()?.nativeElement
      : this.beatBox()?.nativeElement;
  }

  protected onBeatKeydown(event: KeyboardEvent): void {
    if (this.mentionOpen()) {
      this.onMentionKeydown(event);
      if (event.defaultPrevented) {
        return; // the picker consumed this key (e.g. Enter accepted a name)
      }
    }
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
      synopsis: story.synopsis,
      systemPrompt: buildSystemPrompt(story.styleId ?? DEFAULT_STYLE),
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

/** Style properties copied onto the mirror so it wraps text exactly as the box does. */
const MIRROR_PROPS = [
  'boxSizing',
  'width',
  'height',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const;

/**
 * Pixel position of a character index inside a textarea, via the standard
 * hidden-mirror technique: clone the box's text-layout styles into an
 * off-screen div, place a marker span at the index, and read its offset. Used to
 * anchor the `@`-mention picker to the caret.
 */
function caretCoordinates(
  el: HTMLTextAreaElement,
  index: number,
): { top: number; left: number; height: number } {
  const doc = el.ownerDocument;
  const computed = getComputedStyle(el);
  const mirror = doc.createElement('div');
  const style = mirror.style;
  style.position = 'absolute';
  style.top = '0';
  style.left = '-9999px';
  style.visibility = 'hidden';
  style.whiteSpace = 'pre-wrap';
  style.overflowWrap = 'break-word';
  for (const prop of MIRROR_PROPS) {
    style[prop] = computed[prop];
  }

  mirror.textContent = el.value.slice(0, index);
  const marker = doc.createElement('span');
  marker.textContent = el.value.slice(index) || '.';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);

  const top = marker.offsetTop + parseFloat(computed.borderTopWidth);
  const left = marker.offsetLeft + parseFloat(computed.borderLeftWidth);
  const height = parseFloat(computed.lineHeight) || marker.offsetHeight;

  doc.body.removeChild(mirror);
  return { top, left, height };
}

