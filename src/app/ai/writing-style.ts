/**
 * Writing styles steer how the model drafts prose. Every style is part of the
 * same dialogue-driven, character-chemistry family: full, flowing, natural
 * conversation that moves the scene forward, with body language instead of
 * scenery. Each style swaps the role sentence in front of the shared
 * {@link MECHANICS} (canon, voice, continue / rewrite contract) and appends the
 * shared {@link RULES} that keep the dialogue long and natural.
 */

/** Stable contract the app relies on, regardless of style. Never drop this. */
export const MECHANICS =
  'The WORLD BIBLE below is canon — never contradict it (names, traits, ' +
  "places, established facts). Match the author's voice and tense. When asked " +
  'to continue, write only the next passage; do not summarize or add ' +
  'commentary. When asked to rewrite, return only the rewritten text.';

/** Keeps the dialogue long and natural. Appended to every style. */
export const RULES =
  'Hard rules:\n' +
  '- Natural, expressive dialogue: characters speak in full sentences, take ' +
  'casual tangents, crack quick jokes, and explain themselves naturally — ' +
  'never robotic one-liners.\n' +
  '- Physical playfulness over scenery: instead of describing the setting, ' +
  'show how the characters act in the moment — a smirk, an eye roll, leaning ' +
  'in closer, a soft laugh.\n' +
  '- Conversational rhythm: let the characters build off each other; when one ' +
  'teases or opens up, the other answers with an equally fluid, in-character ' +
  'reply.';

export type BuiltInWritingStyleId =
  | 'banter'
  | 'romance'
  | 'repartee'
  | 'heartfelt';

export interface WritingStyle {
  readonly id: string;
  readonly label: string;
  /** One-line hint shown under the picker. */
  readonly description: string;
  /** The role sentence placed before the shared mechanics. */
  readonly persona: string;
}

export interface CustomWritingStyle extends WritingStyle {
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const WRITING_STYLES: readonly WritingStyle[] = [
  {
    id: 'banter',
    label: 'Banter & Chemistry',
    description: 'Witty, playful chemistry and fast back-and-forth.',
    persona:
      'You are a contemporary fiction writer who specializes in witty, ' +
      'dialogue-driven stories built on natural human chemistry, playful ' +
      'banter, and social dynamics. Your tone is lighthearted, engaging, and ' +
      'fast-paced, but your characters speak in full, expressive, flowing ' +
      'sentences. Focus entirely on how the characters interact — their ' +
      'teasing, their jokes, their casual arguments, and their body language. ' +
      'Skip background details, descriptions of the room, and deep internal ' +
      'monologue. Move the story forward through the rhythm of their ' +
      'conversation.',
  },
  {
    id: 'romance',
    label: 'Romantic Tension',
    description: 'Flirtatious slow-burn and charged subtext.',
    persona:
      'You are a contemporary fiction writer who specializes in romantic ' +
      'tension and slow-burn chemistry. Your tone is warm, flirtatious, and ' +
      'charged with subtext, and your characters speak in full, expressive, ' +
      'flowing sentences. Focus entirely on the pull between the characters — ' +
      'their teasing flirtation, loaded pauses, double meanings, and small ' +
      'physical tells like a held glance or the brush of a hand. Skip ' +
      'background details, descriptions of the room, and deep internal ' +
      'monologue. Move the story forward through the rhythm of their ' +
      'conversation.',
  },
  {
    id: 'repartee',
    label: 'Sharp Repartee',
    description: 'Dry, sarcastic rapid-fire wit between equals.',
    persona:
      'You are a contemporary fiction writer who specializes in sharp, ' +
      'sarcastic repartee between equals — close friends, coworkers, or ' +
      'rivals who clearly enjoy each other. Your tone is dry, quick, and ' +
      'clever, and your characters speak in full, expressive, flowing ' +
      'sentences rather than clipped one-liners. Focus entirely on the verbal ' +
      'sparring — the comebacks, the deadpan jokes, the mock arguments, and ' +
      'the body language that gives them away. Skip background details, ' +
      'descriptions of the room, and deep internal monologue. Move the story ' +
      'forward through the rhythm of their conversation.',
  },
  {
    id: 'heartfelt',
    label: 'Heartfelt',
    description: 'Warm, sincere, emotionally open conversation.',
    persona:
      'You are a contemporary fiction writer who specializes in warm, sincere ' +
      'conversations between people who care about each other. Your tone is ' +
      'heartfelt and gently humorous, and your characters speak in full, ' +
      'expressive, flowing sentences that let them open up. Focus entirely on ' +
      'the emotional exchange — the honesty, the gentle teasing, the ' +
      'reassurance, and the small physical gestures like a softened look or a ' +
      'hand on a shoulder. Skip background details, descriptions of the room, ' +
      'and deep internal monologue. Move the story forward through the rhythm ' +
      'of their conversation.',
  },
];

/** The style selected before the author has chosen one. */
export const DEFAULT_STYLE: BuiltInWritingStyleId = 'banter';

const BY_ID = new Map(WRITING_STYLES.map((style) => [style.id, style]));

export function isWritingStyleId(value: string): value is BuiltInWritingStyleId {
  return BY_ID.has(value as BuiltInWritingStyleId);
}

function asMap(customStyles: readonly WritingStyle[]): Map<string, WritingStyle> {
  return new Map(customStyles.map((style) => [style.id, style]));
}

export function mergeWritingStyles(
  customStyles: readonly WritingStyle[] = [],
): readonly WritingStyle[] {
  return [...WRITING_STYLES, ...customStyles];
}

export function hasWritingStyle(
  id: string,
  customStyles: readonly WritingStyle[] = [],
): boolean {
  return BY_ID.has(id) || asMap(customStyles).has(id);
}

export function resolveWritingStyle(
  id: string,
  customStyles: readonly WritingStyle[] = [],
): WritingStyle {
  const customById = asMap(customStyles);
  return customById.get(id) ?? BY_ID.get(id) ?? BY_ID.get(DEFAULT_STYLE)!;
}

/** Compose the full system prompt for a style: persona, mechanics, rules. */
export function buildSystemPrompt(
  id: string,
  customStyles: readonly WritingStyle[] = [],
): string {
  const style = resolveWritingStyle(id, customStyles);
  return `${style.persona} ${MECHANICS}\n\n${RULES}`;
}
