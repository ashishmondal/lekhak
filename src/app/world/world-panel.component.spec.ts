import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Chapter } from '../models/domain';
import { StorageService } from '../services/storage.service';
import { WorldPanelComponent } from './world-panel.component';
import { WorldStore } from './world.store';

async function render(): Promise<{
  fixture: ComponentFixture<WorldPanelComponent>;
  store: WorldStore;
  storage: StorageService;
}> {
  TestBed.configureTestingModule({
    imports: [WorldPanelComponent],
    providers: [provideRouter([]), WorldStore, StorageService],
  });
  const store = TestBed.inject(WorldStore);
  const storage = TestBed.inject(StorageService);
  const fixture = TestBed.createComponent(WorldPanelComponent);
  fixture.detectChanges();
  await fixture.componentInstance.ngOnInit();
  fixture.detectChanges();
  return { fixture, store, storage };
}

describe('WorldPanelComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
  });

  it('adds a card through the form', async () => {
    const { fixture, store } = await render();
    const comp = fixture.componentInstance as any;

    comp.newType.set('character');
    comp.newName.set('Mira');
    comp.newNotes.set('A scholar.');
    await comp.addCard();
    fixture.detectChanges();

    expect(store.cards()).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.card-name')?.value).toBe(
      'Mira',
    );
  });

  it('deletes immediately when a card is not in the prose', async () => {
    const { fixture, store } = await render();
    const comp = fixture.componentInstance as any;

    const card = await store.addCard({
      type: 'lore',
      name: 'The Pact',
      notes: '',
    });
    await comp.requestDelete(card);

    expect(comp.pendingDelete()).toBeNull();
    expect(store.cards()).toHaveLength(0);
  });

  it('asks to confirm when deleting a card that appears in the draft', async () => {
    const { fixture, store, storage } = await render();
    const comp = fixture.componentInstance as any;

    const chapter: Chapter = {
      id: 'default-chapter',
      storyId: 'default-story',
      order: 0,
      title: 'Untitled',
      body: 'And so Mira walked on.',
      updatedAt: Date.now(),
    };
    await storage.putChapter(chapter);
    // Re-init prose now that the chapter exists.
    await comp.ngOnInit();

    const card = await store.addCard({
      type: 'character',
      name: 'Mira',
      notes: '',
    });
    comp.requestDelete(card);

    expect(comp.pendingDelete()).toBe(card.id);
    expect(store.cards()).toHaveLength(1);

    await comp.confirmDelete(card.id);
    expect(store.cards()).toHaveLength(0);
  });
});
