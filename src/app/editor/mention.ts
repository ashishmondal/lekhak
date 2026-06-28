import type { Card } from '../models/domain';

/** Longest `@`-query we still treat as an open mention (guards pathological text). */
const MAX_QUERY = 40;

/** Default number of suggestions surfaced in the dropdown. */
export const MENTION_LIMIT = 8;

export interface ActiveMention {
  /** Text typed after `@`, verbatim (caller lowercases for matching). */
  query: string;
  /** Index of the triggering `@` in the source text. */
  start: number;
  /** Caret index — the exclusive end of the query. */
  end: number;
}

/**
 * Detect an in-progress `@`-mention immediately before the caret.
 *
 * A mention is active when the nearest `@` before the caret sits at the start of
 * the text or right after whitespace (so addresses like `a@b` never trigger),
 * and the run from that `@` up to the caret contains no whitespace. Returns
 * `null` when no mention applies.
 */
export function findActiveMention(
  text: string,
  caret: number,
): ActiveMention | null {
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0) {
    return null;
  }
  const before = at === 0 ? '' : text[at - 1];
  if (before && !/\s/.test(before)) {
    return null;
  }
  const query = text.slice(at + 1, caret);
  if (query.length > MAX_QUERY || /\s/.test(query)) {
    return null;
  }
  return { query, start: at, end: caret };
}

/**
 * Rank character cards against an `@`-query. Empty query lists every character
 * alphabetically; otherwise name/alias prefix matches outrank substring matches.
 * Pass era-resolved cards so the surfaced (and inserted) name is era-correct.
 */
export function rankCharacters(
  cards: Card[],
  query: string,
  limit = MENTION_LIMIT,
): Card[] {
  const q = query.trim().toLowerCase();
  return cards
    .filter((card) => card.type === 'character')
    .map((card) => ({ card, score: matchScore(card, q) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.card.name.localeCompare(b.card.name),
    )
    .slice(0, limit)
    .map((entry) => entry.card);
}

/**
 * Score one card for a lowercased query: 3 = name prefix, 2 = alias prefix,
 * 1 = name/alias substring, 0 = no match. An empty query matches everything so
 * typing a bare `@` opens the full roster.
 */
function matchScore(card: Card, q: string): number {
  if (q === '') {
    return 1;
  }
  const name = card.name.toLowerCase();
  if (name.startsWith(q)) {
    return 3;
  }
  const aliases = (card.aliases ?? []).map((a) => a.toLowerCase());
  if (aliases.some((alias) => alias.startsWith(q))) {
    return 2;
  }
  if (name.includes(q) || aliases.some((alias) => alias.includes(q))) {
    return 1;
  }
  return 0;
}

/** One run of beat text: either plain prose or a recognized `@`-mention chip. */
export interface MentionSegment {
  /** The verbatim source slice (chips include the leading `@`). */
  text: string;
  /** True when this run is an `@`-mention of a known character. */
  chip: boolean;
}

/**
 * Split `text` into plain and chip runs for the beat-editor overlay. A chip is
 * an `@` at the start of the text or right after whitespace, immediately
 * followed by one of `labels` (a character's name or alias) and ending on a
 * word boundary. Matching is case-insensitive; `labels` must be passed
 * longest-first so multi-word names (e.g. "Anil Kapoor") win over a shorter
 * prefix. The returned chip `text` keeps the literal characters (including the
 * `@`) so the overlay stays glyph-aligned with the textarea underneath it.
 */
export function segmentMentions(
  text: string,
  labels: string[],
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const lower = text.toLowerCase();
  let plain = '';
  let i = 0;

  const flushPlain = (): void => {
    if (plain) {
      segments.push({ text: plain, chip: false });
      plain = '';
    }
  };

  while (i < text.length) {
    const atBoundary = i === 0 || /\s/.test(text[i - 1]);
    if (text[i] === '@' && atBoundary) {
      const match = labels.find((label) => {
        if (!lower.startsWith(label.toLowerCase(), i + 1)) {
          return false;
        }
        const after = text[i + 1 + label.length];
        // The match must end the string or stop on a non-word char so that
        // "@An" never chips a label of "Annie", and vice versa.
        return after === undefined || /[^\p{L}\p{N}]/u.test(after);
      });
      if (match) {
        flushPlain();
        segments.push({ text: text.slice(i, i + 1 + match.length), chip: true });
        i += 1 + match.length;
        continue;
      }
    }
    plain += text[i];
    i++;
  }

  flushPlain();
  return segments;
}

