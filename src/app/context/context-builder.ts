import { Service } from '@angular/core';

import type { Card, Chapter, Story } from '../models/domain';
import type { ChatMessage } from '../ai/ai-provider';

/** Token estimate: ~4 chars per token is enough for v1 budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default prompt-context budget, in estimated tokens (leaves room for output). */
export const DEFAULT_TOKEN_BUDGET = 8000;

export const SYSTEM_PROMPT =
  'You are a co-writer helping the author write a short story. The WORLD BIBLE below ' +
  'is canon — never contradict it (names, traits, places, established facts). Match ' +
  "the author's voice and tense. When asked to continue, write only the next passage; " +
  'do not summarize or add commentary. When asked to rewrite, return only the ' +
  'rewritten text.';

export interface ContextInput {
  story: Story;
  /** All chapters of the story; the highest `order` is the current draft. */
  chapters: Chapter[];
  /** World cards (base + per-era overlays). */
  cards: Card[];
  /** "What happens next" steering text (continue mode). */
  nextBeat?: string;
  /** The selected passage to rewrite (rewrite mode). */
  selection?: string;
  /** Text the relevance pass scans; defaults to current draft + beat + selection. */
  recentText?: string;
  /** Cards the author pinned; always included regardless of relevance. */
  pinnedCardIds?: Iterable<string>;
  tokenBudget?: number;
}

export interface ContextResult {
  messages: ChatMessage[];
  /** Resolved cards actually included in the bible (drives the cards chip). */
  usedCards: Card[];
  /** Visible notice when older chapters were dropped to fit; null otherwise. */
  trimmedNote: string | null;
}

/**
 * Snapshot era resolution: overlay deltas merge over the base card. Fields the
 * overlay omits fall back to the base only — never to another era. Era `order`
 * is irrelevant here.
 */
export function resolveCard(card: Card, eraId: string): Card {
  const overlay = card.eraOverlays?.[eraId];
  if (!overlay) {
    return card;
  }
  return {
    ...card,
    name: overlay.name ?? card.name,
    notes: overlay.notes ?? card.notes,
  };
}

/**
 * Relevance selection: keep a card if it is pinned, or if its (resolved) name or
 * any alias appears in `recentText`. Case-insensitive substring match; stable
 * order. Empty names never match.
 */
export function selectRelevant(
  cards: Card[],
  recentText: string,
  pinnedCardIds: Iterable<string> = [],
): Card[] {
  const pinned = new Set(pinnedCardIds);
  const haystack = recentText.toLowerCase();
  return cards.filter((card) => {
    if (pinned.has(card.id)) {
      return true;
    }
    const needles = [card.name, ...(card.aliases ?? [])];
    return needles.some(
      (needle) => needle.trim() !== '' && haystack.includes(needle.toLowerCase()),
    );
  });
}

export interface BudgetResult {
  keptChapters: Chapter[];
  trimmedNote: string | null;
  droppedCount: number;
}

/**
 * Tiered keep. Cards (reserved upstream) come first; the current draft and the
 * immediately prior chapter are always kept; older chapters are added
 * newest-first until the budget is spent. Dropped chapters are always the
 * oldest contiguous run, so the trim is honest and the notice names them.
 */
export function fitBudget(
  chapters: Chapter[],
  reservedTokens: number,
  tokenBudget: number,
): BudgetResult {
  const sorted = [...chapters].sort((a, b) => a.order - b.order);
  const n = sorted.length;
  if (n === 0) {
    return { keptChapters: [], trimmedNote: null, droppedCount: 0 };
  }

  const current = sorted[n - 1];
  const prior = n >= 2 ? sorted[n - 2] : undefined;
  const older = sorted.slice(0, Math.max(0, n - 2)); // oldest → ascending

  let remaining =
    tokenBudget -
    reservedTokens -
    estimateTokens(current.body) -
    (prior ? estimateTokens(prior.body) : 0);

  const keptOlder: Chapter[] = [];
  for (const chapter of [...older].reverse()) {
    const cost = estimateTokens(chapter.body);
    if (cost <= remaining) {
      keptOlder.push(chapter);
      remaining -= cost;
    } else {
      break; // older chapters are even bigger to keep contiguous; stop here
    }
  }

  const droppedCount = older.length - keptOlder.length;
  const keptSet = new Set<Chapter>([
    ...keptOlder,
    ...(prior ? [prior] : []),
    current,
  ]);
  const keptChapters = sorted.filter((chapter) => keptSet.has(chapter));

  const trimmedNote =
    droppedCount > 0
      ? `${
          droppedCount === 1 ? 'Chapter 1' : `Chapters 1–${droppedCount}`
        } trimmed to fit — bible and recent chapters intact`
      : null;

  return { keptChapters, trimmedNote, droppedCount };
}

/** Render the included cards as the labeled WORLD BIBLE markdown block. */
function serializeCards(cards: Card[]): string {
  if (!cards.length) {
    return '';
  }
  const blocks = cards.map((card) => {
    const label = card.type.charAt(0).toUpperCase() + card.type.slice(1);
    const notes = card.notes.trim();
    return `### ${label}: ${card.name}${notes ? `\n${notes}` : ''}`;
  });
  return `## WORLD BIBLE\n${blocks.join('\n')}`;
}

function defaultRecentText(input: ContextInput): string {
  const sorted = [...input.chapters].sort((a, b) => a.order - b.order);
  const currentBody = sorted.at(-1)?.body ?? '';
  return [currentBody, input.nextBeat ?? '', input.selection ?? ''].join(' ');
}

function buildUserContent(
  storySoFar: string,
  nextBeat: string | undefined,
  selection: string | undefined,
): string {
  if (selection) {
    const context = storySoFar ? `${storySoFar}\n\n` : '';
    return `${context}Rewrite the following passage, returning only the rewritten text:\n\n"${selection}"`;
  }
  const beat = nextBeat?.trim();
  const ask = beat
    ? `\n\nWhat happens next: ${beat}\n\nContinue the story:`
    : '\n\nContinue the story:';
  return `${storySoFar}${ask}`;
}

/**
 * Pure context assembly: resolve cards for the story's era, pick the relevant
 * ones, fit chapters into the budget (cards first, recent chapters intact), and
 * emit the provider message list. No IO.
 */
@Service()
export class ContextBuilder {
  build(input: ContextInput): ContextResult {
    const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const recentText = input.recentText ?? defaultRecentText(input);

    const resolved = input.cards.map((card) => resolveCard(card, input.story.eraId));
    const usedCards = selectRelevant(resolved, recentText, input.pinnedCardIds);

    const bible = serializeCards(usedCards);
    const systemContent = bible ? `${SYSTEM_PROMPT}\n\n${bible}` : SYSTEM_PROMPT;

    const reservedTokens =
      estimateTokens(systemContent) +
      estimateTokens(input.nextBeat ?? '') +
      estimateTokens(input.selection ?? '');

    const { keptChapters, trimmedNote } = fitBudget(
      input.chapters,
      reservedTokens,
      budget,
    );

    const storySoFar = keptChapters
      .map((chapter) => chapter.body)
      .filter((body) => body.trim() !== '')
      .join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: buildUserContent(storySoFar, input.nextBeat, input.selection) },
    ];

    return { messages, usedCards, trimmedNote };
  }
}
