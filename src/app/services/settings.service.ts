import { Service, computed, signal } from '@angular/core';

import type { AiProvider } from '../ai/ai-provider';
import { DEFAULT_MODEL } from '../ai/ai-provider';
import { OpenAiProvider } from '../ai/openai-provider';

const KEY_API = 'lekhak.apiKey';
const KEY_PROVIDER = 'lekhak.provider';
const KEY_MODEL = 'lekhak.model';

/** Only provider wired in v1; the field is reserved for future backends. */
export const DEFAULT_PROVIDER = 'openai';

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / disabled storage: settings simply don't persist.
  }
}

/**
 * The single localStorage chokepoint for the BYOK credentials and model choice.
 * Signals stay in sync with storage so the editor can react to a key being
 * entered. {@link buildProvider} constructs the concrete provider on demand so a
 * freshly entered key takes effect on the next generation without a reload.
 */
@Service()
export class SettingsService {
  readonly apiKey = signal(read(KEY_API, ''));
  readonly provider = signal(read(KEY_PROVIDER, DEFAULT_PROVIDER));
  readonly model = signal(read(KEY_MODEL, DEFAULT_MODEL));

  readonly hasKey = computed(() => this.apiKey().trim().length > 0);

  setApiKey(value: string): void {
    this.apiKey.set(value);
    write(KEY_API, value);
  }

  setProvider(value: string): void {
    this.provider.set(value);
    write(KEY_PROVIDER, value);
  }

  setModel(value: string): void {
    this.model.set(value);
    write(KEY_MODEL, value);
  }

  /** Build the concrete provider from the current credentials. */
  buildProvider(): AiProvider {
    return new OpenAiProvider({ apiKey: this.apiKey() });
  }

  /** Verify the key/model against the provider. */
  testConnection(): Promise<boolean> {
    return this.buildProvider().testConnection(this.model());
  }
}
