import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AiError } from '../ai/ai-error';
import { BackupImportError, BackupService } from '../services/backup.service';
import {
  PROVIDERS,
  PROVIDER_LABELS,
  SettingsService,
} from '../services/settings.service';
import { ThemeToggleComponent } from '../theme/theme-toggle.component';

type TestState = 'idle' | 'testing' | 'ok' | 'failed';
type BackupState = 'idle' | 'working' | 'ok' | 'failed';

/** Placeholder hint for each provider's key format. */
const KEY_PLACEHOLDERS: Record<string, string> = {
  openai: 'sk-…',
  gemini: 'AIza…',
};

/**
 * BYOK settings: the API key, model, and a connection test. Everything writes
 * through {@link SettingsService} (the localStorage chokepoint). The key never
 * leaves the browser.
 */
@Component({
  selector: 'app-settings',
  imports: [RouterLink, ThemeToggleComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.css',
})
export class SettingsComponent {
  protected readonly settings = inject(SettingsService);
  private readonly backup = inject(BackupService);

  protected readonly testState = signal<TestState>('idle');
  protected readonly testMessage = signal('');

  protected readonly backupState = signal<BackupState>('idle');
  protected readonly backupMessage = signal('');

  /** Provider options for the picker. */
  protected readonly providers = PROVIDERS.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
  }));

  /** Key-format hint for the active provider. */
  protected readonly keyPlaceholder = computed(
    () => KEY_PLACEHOLDERS[this.settings.provider()] ?? '',
  );

  protected onProviderChange(value: string): void {
    this.settings.setProvider(value);
    this.testState.set('idle');
    this.testMessage.set('');
  }

  protected onKeyInput(value: string): void {
    this.settings.setApiKey(value);
    this.testState.set('idle');
  }

  protected onModelInput(value: string): void {
    this.settings.setModel(value);
    this.testState.set('idle');
  }

  protected async testConnection(): Promise<void> {
    if (!this.settings.hasKey()) {
      this.testState.set('failed');
      this.testMessage.set('Enter an API key first.');
      return;
    }
    this.testState.set('testing');
    this.testMessage.set('');
    try {
      const ok = await this.settings.testConnection();
      this.testState.set(ok ? 'ok' : 'failed');
      this.testMessage.set(
        ok ? 'Connected.' : 'Could not reach the model with this key.',
      );
    } catch (err) {
      this.testState.set('failed');
      this.testMessage.set(
        err instanceof AiError ? err.message : 'Connection failed.',
      );
    }
  }

  /** Download the whole library as a timestamped JSON backup. */
  protected async exportBackup(): Promise<void> {
    this.backupState.set('working');
    this.backupMessage.set('');
    try {
      const json = await this.backup.serialize();
      this.downloadJson(json, this.backupFilename());
      this.backupState.set('ok');
      this.backupMessage.set('Backup downloaded.');
    } catch {
      this.backupState.set('failed');
      this.backupMessage.set('Could not create the backup.');
    }
  }

  /** Import a backup file, replacing all current data after confirmation. */
  protected async onImportFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) {
      return;
    }
    if (!this.confirmReplace()) {
      return;
    }
    this.backupState.set('working');
    this.backupMessage.set('');
    try {
      const text = await file.text();
      await this.backup.importJson(text);
      this.backupState.set('ok');
      this.backupMessage.set('Backup restored. Reloading…');
      this.reload();
    } catch (err) {
      this.backupState.set('failed');
      this.backupMessage.set(
        err instanceof BackupImportError ? err.message : 'Import failed.',
      );
    }
  }

  private backupFilename(): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `lekhak-backup-${stamp}.json`;
  }

  private downloadJson(json: string, filename: string): void {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Seam for tests: confirm a destructive replace before importing. */
  protected confirmReplace(): boolean {
    return confirm(
      'Importing replaces everything currently in this browser. Continue?',
    );
  }

  /** Seam for tests: reload after a successful import. */
  protected reload(): void {
    location.reload();
  }
}
