import { Service } from '@angular/core';

import type { Card, Chapter, Story } from '../models/domain';
import type { ChatMessage } from '../ai/ai-provider';
import { buildSystemPrompt, DEFAULT_STYLE } from '../ai/writing-style';

/** Token estimate: ~4 chars per token is enough for v1 budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default prompt-context budget, in estimated tokens (leaves room for output). */
export const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Share of the budget the story-memory block (synopsis + bible) may occupy.
 * Caps the two together so they never crowd out the recent chapters; the bible
 * (curated by relevance) is kept whole and the synopsis flexes underneath it.
 */
export const MEMORY_CAP_FRACTION = 0.5;

/** Neutral fallback prompt when the caller passes no style override. */
export const SYSTEM_PROMPT = buildSystemPrompt(DEFAULT_STYLE);

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
  /**
   * Rolling summary of chapters trimmed out of the live budget. Passed in by
   * the caller (computed by SynopsisService) so {@link ContextBuilder} stays
   * pure. Shares the memory cap with the bible; truncated if the two overflow.
   */
  synopsis?: string;
  /** Overrides the relevance scan text; defaults to the full kept context (all kept chapters + beat + selection). */
  recentText?: string;
  /** Cards the author pinned; always included regardless of relevance. */
  pinnedCardIds?: Iterable<string>;
  tokenBudget?: number;
  /** Style-specific system prompt; falls back to {@link SYSTEM_PROMPT}. */
  systemPrompt?: string;
}

export interface ContextResult {
  messages: ChatMessage[];
  /** Resolved cards actually included in the bible (drives the cards chip). */
  usedCards: Card[];
  /** Visible notice when older chapters were dropped and/or the synopsis was truncated; null otherwise. */
  trimmedNote: string | null;
  /** Ids of chapters the budget omitted from the prompt (drives the lazy synopsis refresh). */
  droppedChapterIds: string[];
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

/**
 * Text the relevance pass scans: every kept chapter body (ascending), plus the
 * beat and selection. Scanning the whole kept context — not a tail of the
 * current draft — is what lets a character named in an early chapter but only
 * pronoun-referenced near the cursor still resolve into the bible.
 */
function scanText(chapters: Chapter[], nextBeat?: string, selection?: string): string {
  const bodies = [...chapters].sort((a, b) => a.order - b.order).map((c) => c.body);
  return [...bodies, nextBeat ?? '', selection ?? ''].join(' ');
}

/** Truncate `text` to at most `maxTokens` (chars/4), on a word boundary when possible. */
function capText(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) {
    return { text: '', truncated: true };
  }
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  // Only honor the word boundary if it's reasonably close to the end, else a
  // pathological no-space run would throw most of the budget away.
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * Assemble the system message: base prompt, then the STORY SO FAR synopsis, then
 * the WORLD BIBLE. The synopsis is truncated to `synopsisBudget` tokens (the
 * room the builder set aside for it); the curated bible is always kept whole.
 */
function assembleSystemContent(
  basePrompt: string,
  synopsis: string | undefined,
  bible: string,
  synopsisBudget: number,
): { systemContent: string; synopsisNote: string | null } {
  const raw = synopsis?.trim();

  let synopsisBlock = '';
  let synopsisNote: string | null = null;
  if (raw) {
    const { text, truncated } = capText(raw, synopsisBudget);
    if (text) {
      synopsisBlock = `## STORY SO FAR\n${text}`;
    }
    if (truncated) {
      synopsisNote = 'Summary of earlier chapters truncated to fit';
    }
  }

  const systemContent = [basePrompt, synopsisBlock, bible]
    .filter((part) => part !== '')
    .join('\n\n');
  return { systemContent, synopsisNote };
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
    const basePrompt = input.systemPrompt ?? SYSTEM_PROMPT;
    const resolved = input.cards.map((card) => resolveCard(card, input.story.eraId));

    // Order matters: budget BEFORE relevance. We must know which chapters
    // survive into the prompt before scanning them for card mentions —
    // otherwise relevance keys off text that may not match what the model
    // actually sees. Pass 1 reserves only the base prompt + beat + selection
    // (the bible's size is still unknown). Cards can only shrink the chapter
    // budget, so this kept set is a safe superset of the final one.
    //
    //   chapters ─▶ fitBudget(no bible) ─▶ kept' ─▶ selectRelevant ─▶ bible
    //                                                                   │
    //                              fitBudget(with bible) ◀──────────────┘
    //                                       │
    //                                       ▼  final kept chapters
    const baseReserve =
      estimateTokens(basePrompt) +
      estimateTokens(input.nextBeat ?? '') +
      estimateTokens(input.selection ?? '');
    const provisional = fitBudget(input.chapters, baseReserve, budget);

    // Relevance scans the FULL kept context (every kept chapter body, beat and
    // selection). An explicit `recentText` overrides this for callers that
    // want a narrower scan.
    const recentText =
      input.recentText ?? scanText(provisional.keptChapters, input.nextBeat, input.selection);
    const usedCards = selectRelevant(resolved, recentText, input.pinnedCardIds);

    const bible = serializeCards(usedCards);

    // Final chapter budget. The reserve EXCLUDES the synopsis on purpose:
    // deciding which chapters survive without counting the synopsis is what
    // guarantees that enabling a synopsis can never drop a chapter that fit
    // without one (monotonicity). The synopsis then fills only the space the
    // dropped chapters vacated, so the prompt still respects the budget.
    const chapterReserve =
      estimateTokens(basePrompt) +
      estimateTokens(bible) +
      estimateTokens(input.nextBeat ?? '') +
      estimateTokens(input.selection ?? '');
    const { keptChapters, trimmedNote } = fitBudget(
      input.chapters,
      chapterReserve,
      budget,
    );

    // Synopsis budget = the genuine leftover after the kept chapters (so it
    // cannot displace one), bounded by the memory cap it shares with the bible.
    const keptTokens = keptChapters.reduce(
      (sum, chapter) => sum + estimateTokens(chapter.body),
      0,
    );
    const leftover = budget - chapterReserve - keptTokens;
    const memoryRoom = Math.floor(budget * MEMORY_CAP_FRACTION) - estimateTokens(bible);
    const synopsisBudget = Math.max(0, Math.min(leftover, memoryRoom));

    const { systemContent, synopsisNote } = assembleSystemContent(
      basePrompt,
      input.synopsis,
      bible,
      synopsisBudget,
    );

    const storySoFar = keptChapters
      .map((chapter) => chapter.body)
      .filter((body) => body.trim() !== '')
      .join('\n\n');

    const keptIds = new Set(keptChapters.map((chapter) => chapter.id));
    const droppedChapterIds = input.chapters
      .filter((chapter) => !keptIds.has(chapter.id))
      .map((chapter) => chapter.id);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: buildUserContent(storySoFar, input.nextBeat, input.selection) },
    ];

    // One visible notice covers both budget effects: dropped chapters and a
    // truncated synopsis.
    const note = [trimmedNote, synopsisNote].filter((n) => n !== null).join(' · ');
    return {
      messages,
      usedCards,
      trimmedNote: note === '' ? null : note,
      droppedChapterIds,
    };
  }
}
