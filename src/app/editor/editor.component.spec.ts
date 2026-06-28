import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError } from '../ai/ai-error';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { FakeProvider } from '../ai/fake-provider';
import { ContextBuilder } from '../context/context-builder';
import { CanonCheckService } from '../services/canon-check.service';
import { ExtractionService } from '../services/extraction.service';
import { GenerationService } from '../services/generation.service';
import { Autosave } from '../services/autosave';
import { SettingsService } from '../services/settings.service';
import { StorageService } from '../services/storage.service';
import { WorldStore } from '../world/world.store';
import { EditorComponent } from './editor.component';

let navigateSpy: ReturnType<typeof vi.fn>;

/** Minimal stand-in for the story <textarea> that onStoryInput now reads from. */
function storyBox(value: string): HTMLTextAreaElement {
  return { value, selectionStart: value.length } as HTMLTextAreaElement;
}

function configure(provider: FakeProvider): void {
  TestBed.configureTestingModule({
    imports: [EditorComponent],
    providers: [
      { provide: AI_PROVIDER, useValue: provider },
      provideRouter([]),
      ContextBuilder,
      GenerationService,
      Autosave,
      StorageService,
      SettingsService,
    ],
  });
}

/** Render with a key already present so the BYOK guard lets generation run. */
async function render(provider: FakeProvider) {
  configure(provider);
  TestBed.inject(SettingsService).setApiKey('test-key');
  navigateSpy = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
  const fixture = TestBed.createComponent(EditorComponent);
  fixture.detectChanges(); // fires ngOnInit, which kicks off the async bootstrap
  await (fixture.componentInstance as any).initialized;
  fixture.detectChanges(); // reflect the loaded story/chapter state
  return fixture;
}

describe('EditorComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('renders the story and next-beat inputs', async () => {
    const fixture = await render(new FakeProvider());
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.story')).toBeTruthy();
    expect(el.querySelector('.beat')).toBeTruthy();
    expect(el.querySelector('.write')?.textContent).toContain('Write next');
  });

  it('Write next streams the continuation into the story box', async () => {
    const fixture = await render(new FakeProvider({ chunks: ['Once ', 'more.'] }));
    const comp = fixture.componentInstance as any;

    comp.nextBeat.set('keep going');
    await comp.writeNext();

    expect(comp.storyText()).toContain('Once more.');
  });

  it('clears the beat box and keeps it as a ghost after generating', async () => {
    const fixture = await render(new FakeProvider({ chunks: ['x'] }));
    const comp = fixture.componentInstance as any;

    comp.nextBeat.set('a beat');
    await comp.writeNext();

    expect(comp.nextBeat()).toBe('');
    expect(comp.lastBeat()).toBe('a beat');
  });

  it('appends a paragraph break before generated text when prose precedes it', async () => {
    const fixture = await render(new FakeProvider({ chunks: ['New line.'] }));
    const comp = fixture.componentInstance as any;

    comp.storyText.set('Existing.');
    await comp.writeNext();

    expect(comp.storyText()).toBe('Existing.\n\nNew line.');
  });

  it('surfaces a provider error as a banner message', async () => {
    const fixture = await render(
      new FakeProvider({ error: new AiError('auth', 'bad key') }),
    );
    const comp = fixture.componentInstance as any;

    await comp.writeNext();
    fixture.detectChanges();

    expect(comp.errorMessage()).toContain('API key');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.banner')?.textContent,
    ).toContain('API key');
  });

  it('redirects to Settings instead of generating when no key is set', async () => {
    const fixture = await render(new FakeProvider({ chunks: ['nope'] }));
    const comp = fixture.componentInstance as any;
    TestBed.inject(SettingsService).setApiKey('');

    comp.nextBeat.set('go');
    await comp.writeNext();

    expect(navigateSpy).toHaveBeenCalledWith(['/settings']);
    expect(comp.storyText()).toBe('');
  });

  it('autosaves edited prose to storage', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    comp.onStoryInput(storyBox('A durable sentence.'));
    await comp.autosave.flush();

    const stored = await TestBed.inject(StorageService).getChapter(
      'default-chapter',
    );
    expect(stored?.body).toBe('A durable sentence.');
  });

  it('loads a previously saved draft on init', async () => {
    configure(new FakeProvider());
    await TestBed.inject(StorageService).putChapter({
      id: 'default-chapter',
      storyId: 'default-story',
      order: 0,
      title: 'Untitled',
      body: 'Reloaded body.',
      updatedAt: 0,
    });

    const fixture = TestBed.createComponent(EditorComponent);
    await (fixture.componentInstance as any).ngOnInit();

    expect((fixture.componentInstance as any).storyText()).toBe('Reloaded body.');
  });

  it('feeds every chapter to the engine, the latest carrying the live body', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    await comp.newChapter(); // second chapter becomes the active, latest one
    comp.storyText.set('Live frontier text.');

    const gen = TestBed.inject(GenerationService);
    const spy = vi
      .spyOn(gen, 'generate')
      .mockImplementation(async function* () {});

    await comp.writeNext();

    const input = spy.mock.calls[0][0];
    expect(input.chapters.length).toBe(2);
    expect(input.chapters.at(-1)?.body).toBe('Live frontier text.');
  });

  it('refuses to generate while an earlier chapter is open', async () => {
    const fixture = await render(new FakeProvider({ chunks: ['nope'] }));
    const comp = fixture.componentInstance as any;

    await comp.newChapter(); // 2 chapters, latest active
    await comp.stepChapter(-1); // step back to the first, non-latest chapter

    const spy = vi.spyOn(TestBed.inject(GenerationService), 'generate');
    comp.nextBeat.set('go');
    await comp.writeNext();

    expect(spy).not.toHaveBeenCalled();
    expect(comp.stories.isLatestActive()).toBe(false);
  });

  it('flushes the open chapter to storage before switching chapters', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    await comp.newChapter(); // open an empty second chapter
    comp.onStoryInput(storyBox('Chapter two words.'));
    await comp.stepChapter(-1); // leaving ch2 must persist its body first

    const chapters = await TestBed.inject(StorageService).getChaptersByStory(
      'default-story',
    );
    expect(chapters.find((c) => c.order === 1)?.body).toBe('Chapter two words.');
    expect(comp.storyText()).toBe('');
  });

  it('opens a fresh empty chapter when creating a story', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    comp.newStoryTitle.set('Second Tale');
    await comp.createStory();

    expect(comp.stories.activeStory()?.title).toBe('Second Tale');
    expect(comp.stories.chapterCount()).toBe(1);
    expect(comp.storyText()).toBe('');
    expect(comp.showNewStory()).toBe(false);
    expect(comp.newStoryTitle()).toBe('');
  });

  it('anchors a new story to the chosen era and shows it while writing', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    const world = TestBed.inject(WorldStore);
    await world.addEra('Bronze Age');
    const bronze = world.eras().find((e: any) => e.name === 'Bronze Age')!;

    comp.openNewStory();
    comp.newStoryTitle.set('Forged');
    comp.newStoryEraId.set(bronze.id);
    await comp.createStory();

    expect(comp.stories.activeStory()?.eraId).toBe(bronze.id);
    expect(comp.activeEraName()).toBe('Bronze Age');
  });

  it('reorders the active chapter and updates its pager position', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;

    await comp.newChapter(); // second chapter is active, at position 2
    expect(comp.stories.activeChapterNumber()).toBe(2);
    const movedId = comp.stories.activeChapterId();

    await comp.reorderChapter(-1);

    expect(comp.stories.activeChapterId()).toBe(movedId);
    expect(comp.stories.activeChapterNumber()).toBe(1);
  });

  it('deletes the active chapter through confirm and reloads the buffer', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;
    const confirmSpy = vi.spyOn(comp, 'confirm').mockReturnValue(true);

    await comp.newChapter(); // 2 chapters; the empty second is active
    expect(comp.stories.chapterCount()).toBe(2);

    await comp.deleteActiveChapter();

    expect(confirmSpy).toHaveBeenCalled();
    expect(comp.stories.chapterCount()).toBe(1);
    expect(comp.storyText()).toBe(comp.stories.activeChapter()?.body ?? '');
  });

  it('keeps the chapter when the delete confirm is declined', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;
    vi.spyOn(comp, 'confirm').mockReturnValue(false);

    await comp.newChapter();
    await comp.deleteActiveChapter();

    expect(comp.stories.chapterCount()).toBe(2);
  });

  it('deletes the active story through confirm', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;
    vi.spyOn(comp, 'confirm').mockReturnValue(true);

    comp.newStoryTitle.set('Doomed');
    await comp.createStory();
    expect(comp.stories.stories().length).toBe(2);
    const doomed = comp.stories.activeStoryId();

    await comp.deleteActiveStory();

    expect(comp.stories.stories().some((s: any) => s.id === doomed)).toBe(false);
    expect(comp.stories.stories().length).toBe(1);
  });

  it('closes the overflow menu on an outside click and on Escape', async () => {
    const fixture = await render(new FakeProvider());
    const menu = (fixture.nativeElement as HTMLElement).querySelector(
      'details.overflow',
    ) as HTMLDetailsElement;

    menu.open = true;
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menu.open).toBe(false);

    menu.open = true;
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(menu.open).toBe(false);
  });
});

describe('EditorComponent — consistency surfaces', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('points the drift service at the active story on load', async () => {
    const fixture = await render(new FakeProvider());
    const comp = fixture.componentInstance as any;
    const drift = TestBed.inject(CanonCheckService);
    expect(drift.activeStoryId()).toBe(comp.stories.activeStoryId());
  });

  it('delegates a drift dismissal to the canon-check service', async () => {
    const fixture = await render(new FakeProvider());
    const drift = TestBed.inject(CanonCheckService);
    const spy = vi.spyOn(drift, 'dismissDrift').mockResolvedValue();
    await (fixture.componentInstance as any).dismissDrift('flag-1');
    expect(spy).toHaveBeenCalledWith('flag-1');
  });

  it('delegates accept and dismiss of a suggestion to the extraction service', async () => {
    const fixture = await render(new FakeProvider());
    const extraction = TestBed.inject(ExtractionService);
    const accept = vi
      .spyOn(extraction, 'accept')
      .mockResolvedValue({} as never);
    const dismiss = vi.spyOn(extraction, 'dismiss').mockResolvedValue();
    const suggestion = { type: 'character', name: 'Nadia', notes: '' } as never;

    const comp = fixture.componentInstance as any;
    await comp.acceptSuggestion(suggestion);
    await comp.dismissSuggestion(suggestion);

    expect(accept).toHaveBeenCalledWith(suggestion);
    expect(dismiss).toHaveBeenCalledWith(suggestion);
  });

  it('feeds the chapter being left to extraction when a new chapter opens', async () => {
    const fixture = await render(new FakeProvider());
    const extraction = TestBed.inject(ExtractionService);
    const spy = vi.spyOn(extraction, 'onChapterFinalized').mockResolvedValue();
    const comp = fixture.componentInstance as any;

    comp.storyText.set('A long, finished chapter body worth mining.');
    await comp.newChapter();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].body).toContain('finished chapter');
  });

  it('nudges the drift check as the author types', async () => {
    const fixture = await render(new FakeProvider());
    const drift = TestBed.inject(CanonCheckService);
    const spy = vi.spyOn(drift, 'noteDraftChanged');
    const comp = fixture.componentInstance as any;

    comp.onStoryInput(storyBox('The harbor was quiet at dawn.'));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].draft).toContain('harbor');
  });
});

