import { Service, computed, inject, signal } from '@angular/core';

import { AiError } from '../ai/ai-error';
import { DEFAULT_MODEL, type ChatMessage } from '../ai/ai-provider';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { collect, parseJsonLoose } from '../ai/completion';
import type { Card } from '../models/domain';
import { StoryStore } from '../story/story.store';
import { BackgroundQueue } from './background-queue';
import { SettingsService } from './settings.service';

/** Deterministic judgment: a continuity check should not be creative. */
export const DRIFT_TEMPERATURE = 0;
/** Idle gap before an idle-triggered drift check fires, in milliseconds. */
export const DRIFT_IDLE_MS = 6000;
/** Drafts shorter than this (normalized) are too thin to judge meaningfully. */
export const MIN_DRAFT_CHARS = 120;

const DRIFT_SYSTEM = [
  'You are a continuity checker for a work of fiction.',
  'Compare the DRAFT against the established CANON (world facts and the story so far).',
  'Report ONLY clear contradictions where the draft conflicts with an established fact',
  '(e.g. a character described differently, a place that has changed, a fact reversed).',
  'Do NOT flag new information, creative choices, prose style, or anything merely',
  'absent from canon — only genuine conflicts.',
  'Return ONLY JSON of the form',
  '{"flags":[{"card":"<entity name>","issue":"<one sentence: what the draft contradicts>"}]}.',
  'If there are no contradictions, return {"flags":[]}.',
].join(' ');

const CANON_SYSTEM = [
  'You are a canon checker for a work of fiction performing a thorough review.',
  'Check the ENTIRE draft against the full CANON (world facts and the story so far)',
  'and report every place the draft contradicts an established fact.',
  'Be thorough but precise: flag only genuine contradictions, never new information,',
  'prose style, or facts merely absent from canon.',
  'You are an advisor — NEVER rewrite, continue, or edit the draft.',
  'Return ONLY JSON of the form',
  '{"flags":[{"card":"<entity name>","issue":"<one sentence: what the draft contradicts>"}]}.',
  'If there are no contradictions, return {"flags":[]}.',
].join(' ');

/** An advisory continuity flag. `id` is stable across re-checks so a dismissal sticks. */
export interface DriftFlag {
  id: string;
  /** Which card/entity the draft contradicts. */
  card: string;
  /** One sentence describing the contradiction. */
  issue: string;
}

/** Everything a drift check needs; the caller resolves cards for the era first. */
export interface DriftCheckInput {
  storyId: string;
  /** The current chapter body being drafted. */
  draft: string;
  /** World facts in play (already era-resolved by the caller). */
  cards: Card[];
  /** Rolling recap of earlier chapters, if any. */
  synopsis?: string;
  /** Model to judge with; falls back to the provider default. */
  model?: string;
}

/**
 * Advisory continuity checker. Two opt-in surfaces, both OFF by default and both
 * background-only so they never block the writing surface or silently spend the
 * BYOK key:
 *
 *  - **Drift check (T6):** debounced on draft-idle, gated on a *material* change,
 *    flags contradictions between the live draft and canon. Advisory only — it
 *    never edits the author's text, only raises {@link driftFlags}.
 *
 * All work goes through the shared {@link BackgroundQueue}, so a foreground
 * "Write Next" generation always preempts it. Failures are visible (the editor
 * shows a quiet "couldn't analyze" chip) — never silent.
 */
@Service()
export class CanonCheckService {
  private readonly provider = inject(AI_PROVIDER);
  private readonly settings = inject(SettingsService);
  private readonly stories = inject(StoryStore);
  private readonly queue = inject(BackgroundQueue);

  /** The story the editor is currently showing; scopes the exposed signals. */
  readonly activeStoryId = signal<string>('');

  private readonly _flags = signal<Record<string, DriftFlag[]>>({});
  private readonly _error = signal<Record<string, boolean>>({});

  /** Material-diff gate: last normalized draft analyzed per story. */
  private readonly lastAnalyzed = new Map<string, string>();
  /** Debounce timer per story for idle-triggered checks. */
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Drift flags for the active story, minus any the author has dismissed. */
  readonly driftFlags = computed<DriftFlag[]>(() => {
    const id = this.activeStoryId();
    const flags = this._flags()[id] ?? [];
    return flags.filter((f) => !this.stories.isDriftDismissed(id, f.id));
  });

  /** Whether the last drift analysis for the active story failed (visible chip). */
  readonly driftError = computed<boolean>(
    () => this._error()[this.activeStoryId()] ?? false,
  );

  /**
   * Note that the draft changed. Schedules a drift check after an idle gap; a
   * later change before it fires resets the timer (debounce). No-op when the
   * drift surface is toggled off.
   */
  noteDraftChanged(input: DriftCheckInput): void {
    if (!this.settings.driftCheck()) {
      return;
    }
    const existing = this.idleTimers.get(input.storyId);
    if (existing) {
      clearTimeout(existing);
    }
    this.idleTimers.set(
      input.storyId,
      setTimeout(() => {
        this.idleTimers.delete(input.storyId);
        void this.runDriftCheck(input);
      }, DRIFT_IDLE_MS),
    );
  }

  /** Dismiss a drift flag for the active story; it never re-surfaces. */
  async dismissDrift(flagId: string): Promise<void> {
    await this.stories.dismissDrift(this.activeStoryId(), flagId);
  }

  /**
   * Run a drift check now, bypassing the idle debounce but still honoring the
   * opt-in toggle and the material-diff gate. Enqueued on the shared background
   * queue; a foreground generation preempts it.
   */
  async runDriftCheck(input: DriftCheckInput): Promise<void> {
    if (!this.settings.driftCheck()) {
      return;
    }
    const normalized = normalize(input.draft);
    if (normalized.length < MIN_DRAFT_CHARS) {
      return; // too thin to judge
    }
    if (this.lastAnalyzed.get(input.storyId) === normalized) {
      return; // immaterial change since the last analysis
    }
    this.lastAnalyzed.set(input.storyId, normalized);

    try {
      const flags = await this.queue.enqueue((signal) =>
        this.judge(input, signal, DRIFT_SYSTEM),
      );
      this.setFlags(input.storyId, flags);
      this.setError(input.storyId, false);
    } catch (err) {
      if (err instanceof AiError && err.kind === 'aborted') {
        // Preempted by a foreground generation: stay silent and let the next
        // idle re-run by clearing the gate.
        this.lastAnalyzed.delete(input.storyId);
        return;
      }
      // Provider or parse failure → visible "couldn't analyze" state.
      this.setError(input.storyId, true);
    }
  }

  /**
   * Full canon check (E2): on demand, opt-in, default OFF. Compares the whole
   * draft against the complete bible + synopsis and raises advisory flags. It
   * never gates on diff and never rewrites the author's text — flag-only. When
   * the toggle is off it makes no provider call at all.
   */
  async runCanonCheck(input: DriftCheckInput): Promise<void> {
    if (!this.settings.canonCheck()) {
      return;
    }
    try {
      const flags = await this.queue.enqueue((signal) =>
        this.judge(input, signal, CANON_SYSTEM),
      );
      this.setFlags(input.storyId, flags);
      this.setError(input.storyId, false);
    } catch (err) {
      if (err instanceof AiError && err.kind === 'aborted') {
        return;
      }
      this.setError(input.storyId, true);
    }
  }

  private async judge(
    input: DriftCheckInput,
    signal: AbortSignal,
    system: string,
  ): Promise<DriftFlag[]> {
    const text = await collect(this.provider, canonMessages(input, system), {
      model: input.model ?? DEFAULT_MODEL,
      temperature: DRIFT_TEMPERATURE,
      signal,
    });
    const parsed = parseJsonLoose(text, isDriftPayload);
    if (parsed === null) {
      throw new AiError('unknown', 'Could not analyze the draft.');
    }
    return parsed.flags.map((f) => ({
      id: flagId(f.card, f.issue),
      card: f.card,
      issue: f.issue,
    }));
  }

  private setFlags(storyId: string, flags: DriftFlag[]): void {
    this._flags.update((all) => ({ ...all, [storyId]: flags }));
  }

  private setError(storyId: string, failed: boolean): void {
    this._error.update((all) => ({ ...all, [storyId]: failed }));
  }
}

/** Normalize whitespace + case so trivial edits don't re-trigger a check. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable id from the flag content so the same drift keeps the same id. */
function flagId(card: string, issue: string): string {
  const s = `${card.toLowerCase()}|${issue.toLowerCase()}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Render the canon (world facts + story-so-far) the judge compares against. */
function canonBlock(cards: Card[], synopsis?: string): string {
  const facts = cards
    .filter((c) => c.name.trim() !== '')
    .map((c) => {
      const aka = c.aliases?.length ? ` (aka ${c.aliases.join(', ')})` : '';
      return `- ${c.name}${aka}: ${c.notes}`.trim();
    })
    .join('\n');
  const parts: string[] = [];
  if (facts) {
    parts.push(`WORLD FACTS\n${facts}`);
  }
  if (synopsis?.trim()) {
    parts.push(`STORY SO FAR\n${synopsis.trim()}`);
  }
  return parts.join('\n\n');
}

function canonMessages(input: DriftCheckInput, system: string): ChatMessage[] {
  const canon = canonBlock(input.cards, input.synopsis);
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `CANON\n${canon}\n\nDRAFT\n${input.draft}`,
    },
  ];
}

interface DriftPayload {
  flags: { card: string; issue: string }[];
}

function isDriftPayload(value: unknown): value is DriftPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const flags = (value as { flags?: unknown }).flags;
  return (
    Array.isArray(flags) &&
    flags.every(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as { card?: unknown }).card === 'string' &&
        typeof (f as { issue?: unknown }).issue === 'string',
    )
  );
}
