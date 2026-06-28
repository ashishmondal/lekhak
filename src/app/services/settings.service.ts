import { Service, computed, signal } from '@angular/core';

import type { AiProvider } from '../ai/ai-provider';
import { GeminiProvider } from '../ai/gemini-provider';
import { OpenAiProvider } from '../ai/openai-provider';

/** The text backends lekhak can talk to. */
export const PROVIDERS = ['openai', 'gemini'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Provider selected before the user has chosen one. */
export const DEFAULT_PROVIDER: ProviderId = 'openai';

/** Starting model per provider (the field stays free-text). */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

/** Human labels for the provider picker. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};

const KEY_PROVIDER = 'lekhak.provider';
/** Pre-multi-provider keys, migrated into the OpenAI slot on first read. */
const LEGACY_KEY_API = 'lekhak.apiKey';
const LEGACY_KEY_MODEL = 'lekhak.model';

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

function has(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

function apiKeyStore(provider: ProviderId): string {
  return `lekhak.apiKey.${provider}`;
}

function modelStore(provider: ProviderId): string {
  return `lekhak.model.${provider}`;
}

function readProvider(): ProviderId {
  const raw = read(KEY_PROVIDER, DEFAULT_PROVIDER);
  return isProviderId(raw) ? raw : DEFAULT_PROVIDER;
}

/**
 * One-time move of the single-provider `lekhak.apiKey` / `lekhak.model` keys
 * into the namespaced OpenAI slots, so upgrading users keep their credentials.
 * Non-destructive: the legacy keys are left in place and only copied when the
 * namespaced slot is empty.
 */
function migrateLegacy(): void {
  const legacyKey = read(LEGACY_KEY_API, '');
  if (legacyKey && !has(apiKeyStore('openai'))) {
    write(apiKeyStore('openai'), legacyKey);
  }
  const legacyModel = read(LEGACY_KEY_MODEL, '');
  if (legacyModel && !has(modelStore('openai'))) {
    write(modelStore('openai'), legacyModel);
  }
}

/**
 * The single localStorage chokepoint for the BYOK credentials and model choice.
 * Each provider keeps its own key and model, so switching OpenAI <-> Gemini
 * never loses the other's credentials. The visible {@link apiKey} / {@link model}
 * signals always track the active {@link provider}. {@link buildProvider}
 * constructs the concrete provider on demand so a freshly entered key takes
 * effect on the next generation without a reload.
 */
@Service()
export class SettingsService {
  private readonly _migrated = (migrateLegacy(), true);

  readonly provider = signal<ProviderId>(readProvider());
  readonly apiKey = signal(read(apiKeyStore(this.provider()), ''));
  readonly model = signal(
    read(modelStore(this.provider()), DEFAULT_MODELS[this.provider()]),
  );

  readonly hasKey = computed(() => this.apiKey().trim().length > 0);
  /** Default model for the active provider (used as the field placeholder). */
  readonly defaultModel = computed(() => DEFAULT_MODELS[this.provider()]);

  setApiKey(value: string): void {
    this.apiKey.set(value);
    write(apiKeyStore(this.provider()), value);
  }

  setProvider(value: string): void {
    const provider = isProviderId(value) ? value : DEFAULT_PROVIDER;
    this.provider.set(provider);
    write(KEY_PROVIDER, provider);
    // Swap the visible key/model to the newly active provider's stored values.
    this.apiKey.set(read(apiKeyStore(provider), ''));
    this.model.set(read(modelStore(provider), DEFAULT_MODELS[provider]));
  }

  setModel(value: string): void {
    this.model.set(value);
    write(modelStore(this.provider()), value);
  }

  /** Build the concrete provider from the active provider's credentials. */
  buildProvider(): AiProvider {
    if (this.provider() === 'gemini') {
      return new GeminiProvider({ apiKey: this.apiKey() });
    }
    return new OpenAiProvider({ apiKey: this.apiKey() });
  }

  /** Verify the key/model against the provider. */
  testConnection(): Promise<boolean> {
    return this.buildProvider().testConnection(this.model());
  }
}
