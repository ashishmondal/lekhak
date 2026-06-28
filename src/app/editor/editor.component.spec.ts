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
function render(provider: FakeProvider) {
  configure(provider);
  TestBed.inject(SettingsService).setApiKey('test-key');
  navigateSpy = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
  const fixture = TestBed.createComponent(EditorComponent);
  fixture.detectChanges();
  return fixture;
}

describe('EditorComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it('renders the story and next-beat inputs', () => {
    const fixture = render(new FakeProvider());
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.story')).toBeTruthy();
    expect(el.querySelector('.beat')).toBeTruthy();
    expect(el.querySelector('.write')?.textContent).toContain('Write next');
  });

  it('Write next streams the continuation into the story box', async () => {
    const fixture = render(new FakeProvider({ chunks: ['Once ', 'more.'] }));
    const comp = fixture.componentInstance as any;

    comp.nextBeat.set('keep going');
    await comp.writeNext();

    expect(comp.storyText()).toContain('Once more.');
  });

  it('clears the beat box and keeps it as a ghost after generating', async () => {
    const fixture = render(new FakeProvider({ chunks: ['x'] }));
    const comp = fixture.componentInstance as any;

    comp.nextBeat.set('a beat');
    await comp.writeNext();

    expect(comp.nextBeat()).toBe('');
    expect(comp.lastBeat()).toBe('a beat');
  });

  it('appends a paragraph break before generated text when prose precedes it', async () => {
    const fixture = render(new FakeProvider({ chunks: ['New line.'] }));
    const comp = fixture.componentInstance as any;

    comp.storyText.set('Existing.');
    await comp.writeNext();

    expect(comp.storyText()).toBe('Existing.\n\nNew line.');
  });

  it('surfaces a provider error as a banner message', async () => {
    const fixture = render(
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
    const fixture = render(new FakeProvider({ chunks: ['nope'] }));
    const comp = fixture.componentInstance as any;
    TestBed.inject(SettingsService).setApiKey('');

    comp.nextBeat.set('go');
    await comp.writeNext();

    expect(navigateSpy).toHaveBeenCalledWith(['/settings']);
    expect(comp.storyText()).toBe('');
  });

  it('autosaves edited prose to storage', async () => {
    const fixture = render(new FakeProvider());
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
});
