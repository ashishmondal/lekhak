import { Service, computed, inject, signal } from '@angular/core';

import { DEFAULT_STYLE, type WritingStyleId } from '../ai/writing-style';
import type { Chapter, Story } from '../models/domain';
import { MAX_CHAPTERS, StorageService } from '../services/storage.service';

/**
 * Ids the pre-store editor persisted to. The first story/chapter adopt them so
 * an in-progress draft written before this feature becomes Chapter 1 of Story 1
 * with zero migration. New stories/chapters mint fresh uuids.
 */
export const DEFAULT_STORY_ID = 'default-story';
export const DEFAULT_CHAPTER_ID = 'default-chapter';

const ACTIVE_STORY_KEY = 'lekhak.activeStoryId';
const ACTIVE_CHAPTER_KEY = 'lekhak.activeChapterId';

function uuid(): string {
  return crypto.randomUUID();
}

/** Guarded localStorage read: never throws (private mode / disabled storage). */
function readLocal(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Guarded localStorage write: best-effort, never throws. */
function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Active selection is a convenience, not durable state; ignore failures.
  }
}

/**
 * Owns the story/chapter library for the single implicit world: which stories
 * exist, the chapters of the active story, and the active selection (persisted
 * to localStorage so a reload reopens where the author left off).
 *
 * Mirrors {@link WorldStore}: CRUD writes through {@link StorageService} and
 * exposes signals so the editor and (later) the library rail stay in sync.
 * IndexedDB has no foreign keys, so referential rules live here — a story is
 * never chapterless, and the active selection always points at a real record.
 *
 * The continuity engine treats the highest-`order` chapter as the current
 * draft, so {@link isLatestActive} gates whether the editor may continue it.
 */
@Service()
export class StoryStore {
  private readonly storage = inject(StorageService);

  /** All stories in the world, most-recently-updated first. */
  readonly stories = signal<Story[]>([]);
  /** Chapters of the active story, sorted by `order` ascending. */
  readonly chapters = signal<Chapter[]>([]);
  readonly activeStoryId = signal<string>('');
  readonly activeChapterId = signal<string>('');
  readonly ready = signal(false);

  readonly activeStory = computed<Story | null>(
    () => this.stories().find((s) => s.id === this.activeStoryId()) ?? null,
  );
  readonly activeChapter = computed<Chapter | null>(
    () => this.chapters().find((c) => c.id === this.activeChapterId()) ?? null,
  );
  readonly chapterCount = computed(() => this.chapters().length);
  /** True once a story holds the maximum chapters; New chapter is blocked. */
  readonly atChapterCap = computed(() => this.chapters().length >= MAX_CHAPTERS);
  /** 1-based position of the active chapter, for the "Ch 2/4" pager label. */
  readonly activeChapterNumber = computed(() => {
    const i = this.chapters().findIndex((c) => c.id === this.activeChapterId());
    return i < 0 ? 0 : i + 1;
  });
  /**
   * The active chapter is the highest-order (current draft) chapter. The editor
   * only lets Write next run here, because the engine continues the last chapter.
   */
  readonly isLatestActive = computed(() => {
    const cs = this.chapters();
    return cs.length > 0 && cs[cs.length - 1].id === this.activeChapterId();
  });

  /**
   * Load the world's stories, bootstrapping the first one (adopting the legacy
   * default ids) on first run, then restore the active selection.
   */
  async init(worldId: string, eraId: string): Promise<void> {
    if (this.ready()) {
      return;
    }
    let stories = await this.storage.getStoriesByWorld(worldId);
    if (stories.length === 0) {
      stories = [await this.bootstrapFirstStory(worldId, eraId)];
    }
    this.stories.set(sortByRecent(stories));

    // Restore the active story, falling back to the most recent.
    const savedStory = readLocal(ACTIVE_STORY_KEY);
    const activeStory =
      this.stories().find((s) => s.id === savedStory) ?? this.stories()[0];
    this.activeStoryId.set(activeStory.id);

    const chapters = await this.storage.getChaptersByStory(activeStory.id);
    this.chapters.set(chapters);

    // Restore the active chapter, falling back to the latest (the frontier).
    const savedChapter = readLocal(ACTIVE_CHAPTER_KEY);
    const activeChapter =
      chapters.find((c) => c.id === savedChapter) ?? chapters.at(-1);
    this.activeChapterId.set(activeChapter?.id ?? '');
    this.persistSelection();

    this.ready.set(true);
  }

  /**
   * Create the first story, adopting the pre-store `default-story` /
   * `default-chapter` ids so an existing draft survives untouched. Reads any
   * existing default records rather than overwriting them.
   */
  private async bootstrapFirstStory(
    worldId: string,
    eraId: string,
  ): Promise<Story> {
    let story = await this.storage.getStory(DEFAULT_STORY_ID);
    if (!story) {
      story = {
        id: DEFAULT_STORY_ID,
        worldId,
        eraId,
        title: 'Untitled',
        styleId: DEFAULT_STYLE,
        updatedAt: Date.now(),
      };
      await this.storage.putStory(story);
    }

    // A pre-store draft lives under default-chapter (storyId default-story);
    // getChaptersByStory finds it via the byStory index. Only create a fresh
    // chapter when the story genuinely has none.
    const existing = await this.storage.getChaptersByStory(story.id);
    if (existing.length === 0) {
      await this.storage.putChapter({
        id: DEFAULT_CHAPTER_ID,
        storyId: story.id,
        order: 0,
        title: 'Chapter 1',
        body: '',
        updatedAt: Date.now(),
      });
    }
    return story;
  }

  // --- selection ----------------------------------------------------------

  /** Switch to a story, loading its chapters and selecting the latest one. */
  async selectStory(id: string): Promise<void> {
    if (id === this.activeStoryId()) {
      return;
    }
    const story = this.stories().find((s) => s.id === id);
    if (!story) {
      return;
    }
    this.activeStoryId.set(id);
    const chapters = await this.storage.getChaptersByStory(id);
    this.chapters.set(chapters);
    this.activeChapterId.set(chapters.at(-1)?.id ?? '');
    this.persistSelection();
  }

  /** Load a chapter of the active story as the editing target. */
  selectChapter(id: string): void {
    if (!this.chapters().some((c) => c.id === id)) {
      return;
    }
    this.activeChapterId.set(id);
    this.persistSelection();
  }

  /** Move the pager one chapter earlier (-1) or later (+1). No-op at the ends. */
  stepChapter(direction: -1 | 1): void {
    const cs = this.chapters();
    const index = cs.findIndex((c) => c.id === this.activeChapterId());
    const next = index + direction;
    if (index < 0 || next < 0 || next >= cs.length) {
      return;
    }
    this.selectChapter(cs[next].id);
  }

  // --- mutations ----------------------------------------------------------

  /** Create and select a new story (with an empty first chapter). */
  async createStory(
    title: string,
    worldId: string,
    eraId: string,
    styleId: WritingStyleId = DEFAULT_STYLE,
  ): Promise<void> {
    const story: Story = {
      id: uuid(),
      worldId,
      eraId,
      title: title.trim() || 'Untitled',
      styleId,
      updatedAt: Date.now(),
    };
    await this.storage.putStory(story);
    const chapter: Chapter = {
      id: uuid(),
      storyId: story.id,
      order: 0,
      title: 'Chapter 1',
      body: '',
      updatedAt: Date.now(),
    };
    await this.storage.putChapter(chapter);

    this.stories.update((all) => sortByRecent([story, ...all]));
    this.activeStoryId.set(story.id);
    this.chapters.set([chapter]);
    this.activeChapterId.set(chapter.id);
    this.persistSelection();
  }

  /**
   * Append a new chapter to the active story and select it. Blocked (no-op,
   * returns false) once the story is at the chapter cap.
   */
  async createChapter(): Promise<boolean> {
    if (this.atChapterCap()) {
      return false;
    }
    const storyId = this.activeStoryId();
    if (!storyId) {
      return false;
    }
    const order =
      this.chapters().reduce((max, c) => Math.max(max, c.order), -1) + 1;
    const chapter: Chapter = {
      id: uuid(),
      storyId,
      order,
      title: `Chapter ${order + 1}`,
      body: '',
      updatedAt: Date.now(),
    };
    await this.storage.putChapter(chapter);
    this.chapters.update((cs) => [...cs, chapter]);
    this.activeChapterId.set(chapter.id);
    this.persistSelection();
    return true;
  }

  /** Persist the active chapter's body (the editor's autosave target). */
  async saveActiveBody(body: string): Promise<void> {
    const active = this.activeChapter();
    if (!active) {
      return;
    }
    const next: Chapter = { ...active, body, updatedAt: Date.now() };
    await this.storage.putChapter(next);
    this.chapters.update((cs) => cs.map((c) => (c.id === next.id ? next : c)));
  }

  /**
   * Persist a freshly-computed rolling synopsis on a story. Keyed by id (not the
   * active pointer) because the background {@link SynopsisService} may finish
   * after the author has switched stories. Deliberately does NOT bump
   * `updatedAt`: a background recap is housekeeping, not authoring, and must not
   * reorder the library. No-op if the story no longer exists.
   */
  async setSynopsis(storyId: string, synopsis: string): Promise<void> {
    const story = this.stories().find((s) => s.id === storyId);
    if (!story) {
      return;
    }
    const next: Story = { ...story, synopsis, synopsisUpdatedAt: Date.now() };
    await this.storage.putStory(next);
    this.stories.update((all) => all.map((s) => (s.id === storyId ? next : s)));
  }

  /** Has this drift flag been dismissed for the given story? */
  isDriftDismissed(storyId: string, flagId: string): boolean {
    const story = this.stories().find((s) => s.id === storyId);
    return (story?.dismissedDriftIds ?? []).includes(flagId);
  }

  /**
   * Remember a dismissed drift flag so it never re-surfaces for this story.
   * Story-scoped; like {@link setSynopsis} it does not bump `updatedAt` (a
   * dismissal is housekeeping, not authoring).
   */
  async dismissDrift(storyId: string, flagId: string): Promise<void> {
    const story = this.stories().find((s) => s.id === storyId);
    if (!story || (story.dismissedDriftIds ?? []).includes(flagId)) {
      return;
    }
    const next: Story = {
      ...story,
      dismissedDriftIds: [...(story.dismissedDriftIds ?? []), flagId],
    };
    await this.storage.putStory(next);
    this.stories.update((all) => all.map((s) => (s.id === storyId ? next : s)));
  }

  /**
   * Reorder a chapter one slot earlier (-1) or later (+1) within the active
   * story by swapping its `order` with the neighbour's. Auto-labelled titles are
   * renumbered so "Chapter N" tracks position; a custom title (if one ever
   * exists) is preserved. The active selection is unchanged. No-op at the ends.
   */
  async moveChapter(id: string, direction: -1 | 1): Promise<void> {
    const cs = [...this.chapters()].sort((a, b) => a.order - b.order);
    const index = cs.findIndex((c) => c.id === id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= cs.length) {
      return;
    }
    const a = cs[index];
    const b = cs[swapWith];
    const aNext: Chapter = {
      ...a,
      order: b.order,
      title: renumberTitle(a.title, a.order, b.order),
      updatedAt: Date.now(),
    };
    const bNext: Chapter = {
      ...b,
      order: a.order,
      title: renumberTitle(b.title, b.order, a.order),
      updatedAt: Date.now(),
    };
    await this.storage.putChapter(aNext);
    await this.storage.putChapter(bNext);
    this.chapters.set(
      this.chapters()
        .map((c) => (c.id === aNext.id ? aNext : c.id === bNext.id ? bNext : c))
        .sort((x, y) => x.order - y.order),
    );
  }

  /**
   * Delete a chapter of the active story. If it was the only chapter, a fresh
   * empty Chapter 1 takes its place (a story is never chapterless). If it was
   * the active chapter, the prior chapter (or the new first) becomes active.
   */
  async deleteChapter(id: string): Promise<void> {
    const cs = this.chapters();
    const index = cs.findIndex((c) => c.id === id);
    if (index < 0) {
      return;
    }
    await this.storage.deleteChapter(id);

    if (cs.length === 1) {
      // Replace the sole chapter so the story keeps a writable surface.
      const replacement: Chapter = {
        id: uuid(),
        storyId: this.activeStoryId(),
        order: 0,
        title: 'Chapter 1',
        body: '',
        updatedAt: Date.now(),
      };
      await this.storage.putChapter(replacement);
      this.chapters.set([replacement]);
      this.activeChapterId.set(replacement.id);
      this.persistSelection();
      return;
    }

    const remaining = cs.filter((c) => c.id !== id);
    this.chapters.set(remaining);
    if (this.activeChapterId() === id) {
      const fallback = remaining[Math.max(0, index - 1)];
      this.activeChapterId.set(fallback.id);
      this.persistSelection();
    }
  }

  /**
   * Delete a story and all its chapters. If it was active, the next story
   * becomes active; deleting the last story bootstraps a fresh first one.
   */
  async deleteStory(id: string): Promise<void> {
    const story = this.stories().find((s) => s.id === id);
    if (!story) {
      return;
    }
    const chapters = await this.storage.getChaptersByStory(id);
    for (const chapter of chapters) {
      await this.storage.deleteChapter(chapter.id);
    }
    await this.storage.deleteStory(id);

    const remaining = this.stories().filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const fresh = await this.bootstrapFreshStory(story.worldId, story.eraId);
      this.stories.set([fresh.story]);
      this.activeStoryId.set(fresh.story.id);
      this.chapters.set([fresh.chapter]);
      this.activeChapterId.set(fresh.chapter.id);
      this.persistSelection();
      return;
    }

    this.stories.set(remaining);
    if (this.activeStoryId() === id) {
      await this.selectStoryForce(remaining[0].id);
    }
  }

  /** Like {@link selectStory} but does not early-return on an unchanged id. */
  private async selectStoryForce(id: string): Promise<void> {
    this.activeStoryId.set(id);
    const chapters = await this.storage.getChaptersByStory(id);
    this.chapters.set(chapters);
    this.activeChapterId.set(chapters.at(-1)?.id ?? '');
    this.persistSelection();
  }

  /** Create a fresh uuid story + chapter (used when the last story is deleted). */
  private async bootstrapFreshStory(
    worldId: string,
    eraId: string,
  ): Promise<{ story: Story; chapter: Chapter }> {
    const story: Story = {
      id: uuid(),
      worldId,
      eraId,
      title: 'Untitled',
      updatedAt: Date.now(),
    };
    await this.storage.putStory(story);
    const chapter: Chapter = {
      id: uuid(),
      storyId: story.id,
      order: 0,
      title: 'Chapter 1',
      body: '',
      updatedAt: Date.now(),
    };
    await this.storage.putChapter(chapter);
    return { story, chapter };
  }

  private persistSelection(): void {
    writeLocal(ACTIVE_STORY_KEY, this.activeStoryId());
    writeLocal(ACTIVE_CHAPTER_KEY, this.activeChapterId());
  }
}

/** Sort stories most-recently-updated first (stable for equal timestamps). */
function sortByRecent(stories: Story[]): Story[] {
  return [...stories].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The auto-label a chapter gets at a given zero-based order ("Chapter N"). */
function chapterLabel(order: number): string {
  return `Chapter ${order + 1}`;
}

/**
 * Renumber a chapter's title when its order changes during a reorder. Only the
 * default auto-label is rewritten; a custom title is left untouched.
 */
function renumberTitle(title: string, fromOrder: number, toOrder: number): string {
  return title === chapterLabel(fromOrder) ? chapterLabel(toOrder) : title;
}
