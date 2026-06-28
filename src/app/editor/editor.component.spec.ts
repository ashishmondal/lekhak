import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError } from '../ai/ai-error';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { FakeProvider } from '../ai/fake-provider';
import { ContextBuilder } from '../context/context-builder';
import { GenerationService } from '../services/generation.service';
import { Autosave } from '../services/autosave';
import { SettingsService } from '../services/settings.service';
import { StorageService } from '../services/storage.service';
import { EditorComponent } from './editor.component';

let navigateSpy: ReturnType<typeof vi.fn>;

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

    comp.onStoryInput('A durable sentence.');
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
    comp.onStoryInput('Chapter two words.');
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
});
