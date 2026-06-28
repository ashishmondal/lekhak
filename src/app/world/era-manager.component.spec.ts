import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { StorageService } from '../services/storage.service';
import { EraManagerComponent } from './era-manager.component';
import { WorldStore } from './world.store';

async function render(): Promise<{
  fixture: ComponentFixture<EraManagerComponent>;
  store: WorldStore;
}> {
  TestBed.configureTestingModule({
    imports: [EraManagerComponent],
    providers: [WorldStore, StorageService],
  });
  const store = TestBed.inject(WorldStore);
  await store.init();
  const fixture = TestBed.createComponent(EraManagerComponent);
  fixture.detectChanges();
  return { fixture, store };
}

describe('EraManagerComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    globalThis.indexedDB = new IDBFactory();
  });

  it('lists the world eras', async () => {
    const { fixture, store } = await render();
    await store.addEra('Later');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.row');
    expect(rows.length).toBe(2);
  });

  it('shows the named reason when a guarded delete is blocked', async () => {
    const { fixture, store } = await render();
    const comp = fixture.componentInstance as any;

    // Only one era exists, so deletion is blocked.
    await comp.remove(store.eras()[0].id);
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('.error');
    expect(alert?.textContent).toContain('at least one era');
  });

  it('adds an era through the component', async () => {
    const { fixture } = await render();
    const comp = fixture.componentInstance as any;

    comp.newName.set('Five years on');
    await comp.add();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.row');
    expect(rows.length).toBe(2);
    expect(comp.newName()).toBe('');
  });
});
