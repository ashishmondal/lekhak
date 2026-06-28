import { AiError } from './ai-error';
import {
  DEFAULT_TEMPERATURE,
  type AiProvider,
  type ChatMessage,
  type GenerateOpts,
} from './ai-provider';
import { parseSseFrames } from './sse';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiProviderConfig {
  apiKey: string;
  /** Override for proxies / compatible endpoints. */
  baseUrl?: string;
}

/**
 * OpenAI chat-completions provider (BYOK, browser direct).
 *
 * CORS reality: OpenAI permits keyed browser calls, so no proxy is needed.
 * The key is supplied per instance (sourced from SettingsService upstream).
 */
export class OpenAiProvider implements AiProvider {
  readonly id = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *generate(
    messages: ChatMessage[],
    opts: GenerateOpts,
  ): AsyncIterable<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          stream: true,
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
      const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Pull `choices[0].delta.content` from one SSE data payload, tolerating noise. */
function extractDelta(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as {
      choices?: { delta?: { content?: string } }[];
    };
    return parsed.choices?.[0]?.delta?.content;
  } catch {
    return undefined; // non-JSON keep-alive or partial; skip
  }
}
