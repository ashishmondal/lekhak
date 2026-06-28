/**
 * Writing styles steer how the model drafts prose. Each style swaps the role
 * sentence in front of the shared {@link MECHANICS} (canon, voice, continue /
 * rewrite contract). The three "tight" styles also append {@link RULES} to keep
 * the model on dialogue and action instead of scenery and inner monologue.
 *
 * The `cowriter` style is the original neutral prompt, kept verbatim so authors
 * who want no enforced style get exactly the prior behaviour.
 */

/** Stable contract the app relies on, regardless of style. Never drop this. */
export const MECHANICS =
  'The WORLD BIBLE below is canon — never contradict it (names, traits, ' +
  "places, established facts). Match the author's voice and tense. When asked " +
  'to continue, write only the next passage; do not summarize or add ' +
  'commentary. When asked to rewrite, return only the rewritten text.';

/** Appended to every style except `cowriter`. The "short leash". */
export const RULES =
  'Hard rules:\n' +
  '- At least 80% of the text is spoken dialogue or an immediate physical ' +
  'reaction to it.\n' +
  '- Do not describe the room, the weather, the city, or what anyone is ' +
  'wearing unless it is a literal plot point (a hidden weapon, spilled ' +
  'coffee).\n' +
  '- Never modify "said" with an adverb (no "she said nervously"). Let the ' +
  'spoken words carry the emotion.';

export type WritingStyleId =
  | 'screenwriter'
  | 'playwright'
  | 'minimalist'
  | 'cowriter';

interface WritingStyle {
  readonly id: WritingStyleId;
  readonly label: string;
  /** One-line hint shown under the picker. */
  readonly description: string;
  /** The role sentence placed before the shared mechanics. */
  readonly persona: string;
  /** Whether the dialogue/action rules are appended. */
  readonly strict: boolean;
}

export const WRITING_STYLES: readonly WritingStyle[] = [
  {
    id: 'screenwriter',
    label: 'Screenwriter',
    description: 'Sharp dialogue and momentum. Best all-round.',
    persona:
      'You are an award-winning screenwriter drafting a tightly paced indie ' +
      'film, working in prose. You are hyper-focused on sharp dialogue, ' +
      'subtext, and immediate narrative momentum. If a sentence does not ' +
      'advance the plot or reveal a character flaw through speech, cut it. No ' +
      'internal monologue, no scenery, no poetic prose.',
    strict: true,
  },
  {
    id: 'playwright',
    label: 'Playwright',
    description: 'Rapid-fire conversation, high tension.',
    persona:
      'You are a minimalist playwright in the vein of David Mamet or Harold ' +
      'Pinter, writing in prose but staging it like a play: rapid-fire, ' +
      'realistic conversation, interruptions, and subtext. Keep sentences ' +
      'short. Ignore the environment unless a character physically interacts ' +
      'with an object to move the scene forward.',
    strict: true,
  },
  {
    id: 'minimalist',
    label: 'Minimalist',
    description: 'Bare-bones Carver / Davis prose.',
    persona:
      'You are a ruthless minimalist fiction writer in the vein of Raymond ' +
      'Carver or Lydia Davis. Show, do not tell. Focus entirely on dialogue ' +
      'and immediate action. Strip every adverb, every decorative ' +
      'description, and any background lore. Give only the bare bones of the ' +
      'interaction.',
    strict: true,
  },
  {
    id: 'cowriter',
    label: 'Plain co-writer',
    description: 'Matches your voice, no enforced style.',
    persona: 'You are a co-writer helping the author write a short story.',
    strict: false,
  },
];

/** The style selected before the author has chosen one. */
export const DEFAULT_STYLE: WritingStyleId = 'screenwriter';

const BY_ID = new Map(WRITING_STYLES.map((style) => [style.id, style]));

export function isWritingStyleId(value: string): value is WritingStyleId {
  return BY_ID.has(value as WritingStyleId);
}

/** Compose the full system prompt for a style: persona, mechanics, rules. */
export function buildSystemPrompt(id: WritingStyleId): string {
  const style = BY_ID.get(id) ?? BY_ID.get(DEFAULT_STYLE)!;
  const base = `${style.persona} ${MECHANICS}`;
  return style.strict ? `${base}\n\n${RULES}` : base;
}
