import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { Card, CardType } from '../models/domain';
import { StorageService } from '../services/storage.service';
import { EraManagerComponent } from './era-manager.component';
import { WorldStore } from './world.store';
import { ThemeToggleComponent } from '../theme/theme-toggle.component';

const DRAFT_CHAPTER_ID = 'default-chapter';

const CARD_TYPES: CardType[] = ['character', 'place', 'lore'];

/**
 * The world bible: cards (characters, places, lore) and the eras they shift
 * across. Editing a card's overlay for the selected era is what lets the AI see
 * who someone was at that point in time. Deleting a card that appears in the
 * current draft asks for confirmation rather than silently removing it.
 */
@Component({
  selector: 'app-world-panel',
  imports: [RouterLink, EraManagerComponent, ThemeToggleComponent],
  templateUrl: './world-panel.component.html',
  styleUrl: './world-panel.component.css',
})
export class WorldPanelComponent implements OnInit {
  protected readonly store = inject(WorldStore);
  private readonly storage = inject(StorageService);

  protected readonly types = CARD_TYPES;
  protected readonly newType = signal<CardType>('character');
  protected readonly newName = signal('');
  protected readonly newNotes = signal('');

  /** Card id awaiting a "delete anyway?" confirmation. */
  protected readonly pendingDelete = signal<string | null>(null);
  /** Current draft prose, for the appears-in-story soft warning. */
  private readonly prose = signal('');

  async ngOnInit(): Promise<void> {
    await this.store.init();
    const chapter = await this.storage.getChapter(DRAFT_CHAPTER_ID);
    this.prose.set(chapter?.body ?? '');
  }

  protected async addCard(): Promise<void> {
    const name = this.newName().trim();
    if (!name) {
      return;
    }
    await this.store.addCard({
      type: this.newType(),
      name,
      notes: this.newNotes(),
    });
    this.newName.set('');
    this.newNotes.set('');
  }

  protected renameCard(card: Card, name: string): void {
    void this.store.updateCard({ ...card, name });
  }

  protected setNotes(card: Card, notes: string): void {
    void this.store.updateCard({ ...card, notes });
  }

  protected overlayName(card: Card): string {
    return card.eraOverlays?.[this.store.currentEraId()]?.name ?? '';
  }

  protected overlayNotes(card: Card): string {
    return card.eraOverlays?.[this.store.currentEraId()]?.notes ?? '';
  }

  protected setOverlayName(card: Card, name: string): void {
    void this.store.setOverlay(card.id, this.store.currentEraId(), {
      name,
      notes: this.overlayNotes(card),
    });
  }

  protected setOverlayNotes(card: Card, notes: string): void {
    void this.store.setOverlay(card.id, this.store.currentEraId(), {
      name: this.overlayName(card),
      notes,
    });
  }

  protected requestDelete(card: Card): Promise<void> {
    if (this.store.cardAppearsInProse(card, this.prose())) {
      this.pendingDelete.set(card.id);
      return Promise.resolve();
    }
    return this.confirmDelete(card.id);
  }

  protected async confirmDelete(id: string): Promise<void> {
    this.pendingDelete.set(null);
    await this.store.deleteCard(id);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }
}
