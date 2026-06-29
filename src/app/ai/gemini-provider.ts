import { AiError } from './ai-error';
import {
  DEFAULT_TEMPERATURE,
  isTurboStory,
  type AiProvider,
  type ChatMessage,
  type GenerateOpts,
} from './ai-provider';
import { parseSseFrames } from './sse';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderConfig {
  apiKey: string;
  /** Override for proxies / compatible endpoints. */
  baseUrl?: string;
}

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Google Gemini provider (BYOK, browser direct).
 *
 * Wire format differs from OpenAI in three ways the interface hides from the
 * rest of the app:
 * - the system prompt rides a dedicated `systemInstruction` field, not a turn;
 * - turn roles are `user` / `model` (no `assistant`, no `system`);
 * - streamed text lives at `candidates[0].content.parts[0].text`.
 *
 * Streaming uses `:streamGenerateContent?alt=sse`, which emits the same
 * `\n\n`-delimited SSE frames {@link parseSseFrames} already reads. Gemini ends
 * the stream by closing it (no `[DONE]` sentinel), which the reader handles.
 *
 * Auth goes in the `x-goog-api-key` header rather than a `?key=` query param so
 * the key never lands in referrer headers or proxy logs.
 */
export class GeminiProvider implements AiProvider {
  readonly id = 'gemini';
  /** Turbo mode for the current run, derived from the story name. Used later. */
  turbo = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *generate(
    messages: ChatMessage[],
    opts: GenerateOpts,
  ): AsyncIterable<string> {
    this.turbo = isTurboStory(opts.storyName);
    const { contents, systemInstruction } = toGeminiRequest(messages);
    const url =
      `${this.baseUrl}/models/${encodeURIComponent(opts.model)}` +
      ':streamGenerateContent?alt=sse';

    const safetySettings = [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
    ].map((category) => ({
      category,
      threshold: this.turbo ? 'BLOCK_NONE' : 'BLOCK_LOW_AND_ABOVE',
    }));

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          ...(systemInstruction ? { systemInstruction } : {}),
          contents,
          safetySettings,
          generationConfig: {
            temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
            ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
          },
        }),
        signal: opts.signal,
      });
    } catch (err) {
      throw AiError.fromThrown(err, opts.signal);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw AiError.fromStatus(res.status, body);
    }
    if (!res.body) {
      throw new AiError('network', 'No response stream from provider.');
    }

    try {
      for await (const data of parseSseFrames(res.body, opts.signal)) {
        const delta = extractDelta(data);
        if (delta) {
          yield delta;
        }
      }
    } catch (err) {
      throw AiError.fromThrown(err, opts.signal);
    }
  }

  async testConnection(model: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(model)}`,
        { headers: { 'x-goog-api-key': this.apiKey } },
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Translate the provider-neutral message list into Gemini's request shape:
 * `system` turns collapse into a single `systemInstruction`, `assistant` maps
 * to `model`, and everything else is a `user` turn.
 */
export function toGeminiRequest(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemTexts.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }

  const systemInstruction = systemTexts.length
    ? { parts: [{ text: systemTexts.join('\n\n') }] }
    : undefined;

  return { contents, systemInstruction };
}

/** Pull `candidates[0].content.parts[0].text` from one SSE data payload. */
function extractDelta(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as {
      candidates?: { 
        content?: { parts?: { text?: string }[] };
        finishReason?: string;
      }[];
      promptFeedback?: {
        blockReason?: string;
      };
    };

    // 1. Check if the prompt itself was blocked before generation started
    if (parsed.promptFeedback?.blockReason) {
      throw new AiError(
        'content_prohibited', 
        ` request was blocked by safety filters: ${parsed.promptFeedback.blockReason}`
      );
    }

    const candidate = parsed.candidates?.[0];

    // 2. Check if streaming was cut short mid-way due to safety or prohibited content
    if (candidate?.finishReason === 'SAFETY') {
      throw new AiError(
        'content_prohibited', 
        'Generation stopped because the generated content violated safety policies.'
      );
    }

    return candidate?.content?.parts?.[0]?.text;
  } catch (err) {
    // If we intentionally threw an AiError above, pass it through
    if (err instanceof AiError) {
      throw err;
    }
    return undefined; // non-JSON keep-alive or partial; skip safely
  }
}