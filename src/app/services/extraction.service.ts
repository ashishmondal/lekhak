import { Service, computed, inject, signal } from '@angular/core';

import { AiError } from '../ai/ai-error';
import { DEFAULT_MODEL, type ChatMessage } from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { collect, parseJsonLoose } from '../ai/completion';
import type { Card, CardType } from '../models/domain';
import { WorldStore } from '../world/world.store';
import { BackgroundQueue } from './background-queue';
import { SettingsService } from './settings.service';

/** Deterministic: extraction reads what is on the page, it does not invent. */
export const EXTRACTION_TEMPERATURE = 0;
/** Chapters shorter than this (normalized) rarely introduce trackable entities. */
export const MIN_CHAPTER_CHARS = 200;

const CARD_TYPES: readonly CardType[] = ['character', 'place', 'lore'];

const EXTRACTION_SYSTEM = [
  'You are a story-bible assistant. Read the CHAPTER and list notable NEW named',
  'entities a writer would want to track for continuity: characters, places, and',
  'lore (objects, factions, concepts).',
  'For each, give: type (one of "character", "place", "lore"), the name, any',
  'aliases used in the text, and a one-sentence note grounded ONLY in the chapter.',
  'Do not invent details, and skip generic or unnamed entities.',
  'Return ONLY JSON of the form',
  '{"cards":[{"type":"character","name":"...","aliases":["..."],"notes":"..."}]}.',
  'If there are no notable new entities, return {"cards":[]}.',
].join(' ');

/** A suggested world card the author may Accept (creates it) or Dismiss. */
export interface ExtractionSuggestion {
  type: CardType;
  name: string;
  aliases?: string[];
  notes: string;
}

/** Input for one finalize-time extraction pass. */
export interface ExtractionInput {
  /** The finalized chapter being mined (for coalescing). */
  chapterId: string;
  /** The finalized chapter body. */
  body: string;
  /** Model to extract with; falls back to the provider default. */
  model?: string;
}

/**
 * Mines a finalized chapter for new world cards — opt-in, background, and
 * **suggest-only**. It never writes to the world on its own: the author Accepts
 * a suggestion (which creates a `source:'extracted'` card) or Dismisses it
 * (remembered world-wide so the name never nags again).
 *
 * Suggestions are deduped live against existing card names/aliases and the
 * world's dismissed-name list, so accepting one (or adding a card by hand)
 * removes it from the tray automatically. Failures are visible, never silent.
 */
@Service()
export class ExtractionService {
  private readonly provider = inject(AI_PROVIDER);
  private readonly settings = inject(SettingsService);
  private readonly world = inject(WorldStore);
  private readonly queue = inject(BackgroundQueue);

  private readonly _raw = signal<ExtractionSuggestion[]>([]);
  private readonly _error = signal(false);

  /** Last chapter+text already extracted, to coalesce repeat triggers. */
  private lastExtracted = '';

  /** Pending suggestions, minus anything already known or dismissed in the world. */
  readonly suggestions = computed<ExtractionSuggestion[]>(() => {
    const known = knownNames(this.world.cards());
    return this._raw().filter((s) => {
      const key = s.name.trim().toLowerCase();
      return key !== '' && !known.has(key) && !this.world.isNameDismissed(key);
    });
  });

  /** Whether the last extraction failed (drives the visible "couldn't analyze" chip). */
  readonly extractionError = computed(() => this._error());

  /**
   * Mine a freshly-finalized chapter for new cards. No-op when the extraction
   * surface is toggled off or the chapter is too thin. Returns immediately is
   * not guaranteed — callers fire-and-forget; the chapter switch never waits.
   */
  async onChapterFinalized(input: ExtractionInput): Promise<void> {
    if (!this.settings.extraction()) {
      return;
    }
    const normalized = normalize(input.body);
    if (normalized.length < MIN_CHAPTER_CHARS) {
      return;
    }
    const signature = `${input.chapterId}:${normalized}`;
    if (signature === this.lastExtracted) {
      return; // already mined this exact text
    }
    this.lastExtracted = signature;

    try {
      const cards = await this.queue.enqueue((signal) =>
        this.extract(input, signal),
      );
      this._raw.set(cards);
      this._error.set(false);
    } catch (err) {
      if (err instanceof AiError && err.kind === 'aborted') {
        this.lastExtracted = ''; // preempted — allow a re-run
        return;
      }
      this._error.set(true);
    }
  }

  /** Accept a suggestion: create an `extracted` card. Suggestion drops out live. */
  async accept(suggestion: ExtractionSuggestion): Promise<Card> {
    const card = await this.world.addCard({
      type: suggestion.type,
      name: suggestion.name,
      notes: suggestion.notes,
      aliases: suggestion.aliases,
      source: 'extracted',
    });
    this.drop(suggestion.name);
    return card;
  }

  /** Dismiss a suggestion: never suggest this name again in this world. */
  async dismiss(suggestion: ExtractionSuggestion): Promise<void> {
    await this.world.dismissName(suggestion.name);
    this.drop(suggestion.name);
  }

  private drop(name: string): void {
    const key = name.trim().toLowerCase();
    this._raw.update((list) =>
      list.filter((s) => s.name.trim().toLowerCase() !== key),
    );
  }

  private async extract(
    input: ExtractionInput,
    signal: AbortSignal,
  ): Promise<ExtractionSuggestion[]> {
    const text = await collect(this.provider, extractionMessages(input), {
      model: input.model ?? DEFAULT_MODEL,
      temperature: EXTRACTION_TEMPERATURE,
      signal,
    });
    const parsed = parseJsonLoose(text, isExtractionPayload);
    if (parsed === null) {
      throw new AiError('unknown', 'Could not analyze the chapter.');
    }
    return parsed.cards.map((c) => ({
      type: CARD_TYPES.includes(c.type as CardType)
        ? (c.type as CardType)
        : 'lore',
      name: c.name.trim(),
      aliases: c.aliases?.length
        ? c.aliases.map((a) => a.trim()).filter((a) => a !== '')
        : undefined,
      notes: c.notes.trim(),
    }));
  }
}

/** Normalize whitespace + case so trivial differences don't re-trigger. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every existing card name + alias, lowercased, for dedupe. */
function knownNames(cards: Card[]): Set<string> {
  const set = new Set<string>();
  for (const card of cards) {
    for (const n of [card.name, ...(card.aliases ?? [])]) {
      const key = n.trim().toLowerCase();
      if (key !== '') {
        set.add(key);
      }
    }
  }
  return set;
}

function extractionMessages(input: ExtractionInput): ChatMessage[] {
  return [
    { role: 'system', content: EXTRACTION_SYSTEM },
    { role: 'user', content: `CHAPTER\n${input.body}` },
  ];
}

interface ExtractionPayload {
  cards: { type: string; name: string; aliases?: string[]; notes: string }[];
}

function isExtractionPayload(value: unknown): value is ExtractionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cards = (value as { cards?: unknown }).cards;
  return (
    Array.isArray(cards) &&
    cards.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { name?: unknown }).name === 'string' &&
        typeof (c as { notes?: unknown }).notes === 'string' &&
        typeof (c as { type?: unknown }).type === 'string' &&
        (((c as { aliases?: unknown }).aliases === undefined) ||
          (Array.isArray((c as { aliases?: unknown }).aliases) &&
            ((c as { aliases: unknown[] }).aliases).every(
              (a) => typeof a === 'string',
            ))),
    )
  );
}
