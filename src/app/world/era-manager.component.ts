import { Component, inject, signal } from '@angular/core';

import { WorldStore } from './world.store';

/**
 * Manage the world's eras: add, rename, reorder, and delete. Deletes are
 * guarded by {@link WorldStore.deleteEra}; a blocked delete shows the named
 * reason inline rather than silently failing.
 */
@Component({
  selector: 'app-era-manager',
  imports: [],
  templateUrl: './era-manager.component.html',
  styleUrl: './era-manager.component.css',
})
export class EraManagerComponent {
  protected readonly store = inject(WorldStore);

  protected readonly newName = signal('');
  protected readonly error = signal('');

  protected async add(): Promise<void> {
    const name = this.newName().trim();
    if (!name) {
      return;
    }
    await this.store.addEra(name);
    this.newName.set('');
  }

  protected async rename(id: string, value: string): Promise<void> {
    await this.store.renameEra(id, value);
  }

  protected async move(id: string, direction: -1 | 1): Promise<void> {
    await this.store.moveEra(id, direction);
  }

  protected async remove(id: string): Promise<void> {
    this.error.set('');
    const result = await this.store.deleteEra(id);
    if (!result.ok) {
      this.error.set(result.reason);
    }
  }
}
