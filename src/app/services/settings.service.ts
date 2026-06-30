import { Service, computed, signal } from '@angular/core';

import type { AiProvider } from '../ai/ai-provider';
import { GeminiProvider } from '../ai/gemini-provider';
import { OpenAiProvider } from '../ai/openai-provider';
import {
  type CustomWritingStyle,
  DEFAULT_STYLE,
  hasWritingStyle,
  isWritingStyleId,
} from '../ai/writing-style';

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
const KEY_STYLE = 'lekhak.style';
const KEY_CUSTOM_STYLES = 'lekhak.customStyles';
/** Opt-in consistency surfaces, all OFF by default (each costs BYOK tokens). */
const KEY_DRIFT = 'lekhak.consistency.drift';
const KEY_EXTRACTION = 'lekhak.consistency.extraction';
const KEY_CANON = 'lekhak.consistency.canon';
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

/** Boolean toggles persist as the literal 'true'/'false'; absent reads false. */
function readBool(key: string): boolean {
  return read(key, 'false') === 'true';
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

function readStyle(): string {
  return read(KEY_STYLE, DEFAULT_STYLE);
}

function readCustomStyles(): CustomWritingStyle[] {
  const raw = read(KEY_CUSTOM_STYLES, '[]');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => sanitizeCustomStyle(item))
      .filter((item): item is CustomWritingStyle => !!item);
  } catch {
    return [];
  }
}

function writeCustomStyles(styles: readonly CustomWritingStyle[]): void {
  write(KEY_CUSTOM_STYLES, JSON.stringify(styles));
}

function sanitizeCustomStyle(value: unknown): CustomWritingStyle | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Partial<CustomWritingStyle>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const label = typeof item.label === 'string' ? item.label.trim() : '';
  const description =
    typeof item.description === 'string' ? item.description.trim() : '';
  const persona = typeof item.persona === 'string' ? item.persona.trim() : '';
  if (!id || !label || !persona) {
    return null;
  }
  const now = Date.now();
  const createdAt =
    typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
      ? item.createdAt
      : now;
  const updatedAt =
    typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
      ? item.updatedAt
      : createdAt;
  return { id, label, description, persona, createdAt, updatedAt };
}

function customStyleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

  /** The default writing style seeded into the new-story form. Each story
   * locks its own style at creation, so changing this never alters an
   * existing story. */
  readonly customStyles = signal<CustomWritingStyle[]>(readCustomStyles());

  readonly style = signal<string>(this.readInitialStyle());

  /**
   * Opt-in consistency surfaces. All default OFF: each spends extra BYOK tokens
   * on the author's own key, so nothing runs until they explicitly enable it.
   * - drift: advisory contradiction check while drafting.
   * - extraction: suggest new world cards from finalized chapters.
   * - canon: full canon check of the draft against the bible.
   */
  readonly driftCheck = signal<boolean>(readBool(KEY_DRIFT));
  readonly extraction = signal<boolean>(readBool(KEY_EXTRACTION));
  readonly canonCheck = signal<boolean>(readBool(KEY_CANON));

  setDriftCheck(value: boolean): void {
    this.driftCheck.set(value);
    write(KEY_DRIFT, value ? 'true' : 'false');
  }

  setExtraction(value: boolean): void {
    this.extraction.set(value);
    write(KEY_EXTRACTION, value ? 'true' : 'false');
  }

  setCanonCheck(value: boolean): void {
    this.canonCheck.set(value);
    write(KEY_CANON, value ? 'true' : 'false');
  }

  setStyle(value: string): void {
    const style = hasWritingStyle(value, this.customStyles())
      ? value
      : DEFAULT_STYLE;
    this.style.set(style);
    write(KEY_STYLE, style);
  }

  addCustomStyle(input: {
    label: string;
    description: string;
    persona: string;
  }): string | null {
    const label = input.label.trim();
    const description = input.description.trim();
    const persona = input.persona.trim();
    if (!label || !persona) {
      return null;
    }
    const now = Date.now();
    const id = customStyleId();
    const next: CustomWritingStyle = {
      id,
      label,
      description,
      persona,
      createdAt: now,
      updatedAt: now,
    };
    this.customStyles.update((styles) => {
      const merged = [...styles, next];
      writeCustomStyles(merged);
      return merged;
    });
    return id;
  }

  updateCustomStyle(
    id: string,
    input: { label: string; description: string; persona: string },
  ): boolean {
    const label = input.label.trim();
    const description = input.description.trim();
    const persona = input.persona.trim();
    if (!label || !persona) {
      return false;
    }
    let changed = false;
    this.customStyles.update((styles) => {
      const next = styles.map((style) => {
        if (style.id !== id) {
          return style;
        }
        changed = true;
        return {
          ...style,
          label,
          description,
          persona,
          updatedAt: Date.now(),
        };
      });
      if (changed) {
        writeCustomStyles(next);
      }
      return next;
    });
    return changed;
  }

  deleteCustomStyle(id: string): void {
    this.customStyles.update((styles) => {
      const next = styles.filter((style) => style.id !== id);
      if (next.length !== styles.length) {
        writeCustomStyles(next);
      }
      return next;
    });
    if (this.style() === id) {
      this.setStyle(DEFAULT_STYLE);
    }
  }

  private readInitialStyle(): string {
    const raw = readStyle();
    if (isWritingStyleId(raw)) {
      return raw;
    }
    return hasWritingStyle(raw, this.customStyles()) ? raw : DEFAULT_STYLE;
  }

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
