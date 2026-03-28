/**
 * LLM Providers
 *
 * Two concrete implementations of LlmProvider:
 *   - OpenAIProvider: for GPT-4o-mini (Stage 1 — cheap classifier)
 *   - AnthropicProvider: for claude-sonnet-4-6 (Stage 4 — code generator)
 *
 * Both use the native fetch API (Node 20+), no SDK dependencies.
 * This keeps the package lean and avoids SDK version conflicts.
 */

import type { LlmCompleteParams, LlmCompleteResult, LlmProvider } from '../types/pipeline.types.js';

// ─── OpenAI Provider (GPT-4o-mini) ────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: 'json_object' };
}

interface OpenAIResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export class OpenAIProvider implements LlmProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; modelId?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId ?? 'gpt-4o-mini';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    const startMs = Date.now();

    const body: OpenAIRequest = {
      model: this.modelId,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userMessage },
      ],
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      ...(params.jsonMode === true && { response_format: { type: 'json_object' } }),
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmProviderError(
        `OpenAI API error ${response.status}: ${errorText}`,
        response.status,
        this.modelId,
      );
    }

    const data = (await response.json()) as OpenAIResponse;
    const content = data.choices[0]?.message.content ?? '';

    return {
      content,
      tokensUsed: data.usage.total_tokens,
      modelId: this.modelId,
      durationMs: Date.now() - startMs,
    };
  }
}

// ─── Anthropic Provider (claude-sonnet-4-6) ───────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: AnthropicMessage[];
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; modelId?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.modelId = config.modelId ?? 'claude-sonnet-4-6';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompleteResult> {
    const startMs = Date.now();

    const body: AnthropicRequest = {
      model: this.modelId,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: params.systemPrompt,
      messages: [{ role: 'user', content: params.userMessage }],
    };

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmProviderError(
        `Anthropic API error ${response.status}: ${errorText}`,
        response.status,
        this.modelId,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    const content = textBlock?.text ?? '';

    return {
      content,
      tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
      modelId: this.modelId,
      durationMs: Date.now() - startMs,
    };
  }
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly modelId: string,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/**
 * Strips accidental markdown fences and parses JSON.
 * Used by all stages that expect JSON-only LLM output.
 *
 * Strategy:
 *   1. Try direct parse (ideal — model returned clean JSON)
 *   2. Strip markdown fences and retry
 *   3. Extract the first top-level JSON object ({...}) via brace matching
 *   4. If all fail, throw JsonParseError
 */
export function parseJsonResponse<T>(raw: string): T {
  // 1. Try direct parse
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continue to next strategy
  }

  // 2. Strip markdown fences (```json ... ``` or ``` ... ```)
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/im, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // continue to next strategy
  }

  // 3. Extract first top-level JSON object via brace matching
  const extracted = extractJsonObject(cleaned);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // fall through to error
    }
  }

  throw new JsonParseError(
    `Failed to parse LLM JSON response after all extraction strategies`,
    raw.slice(0, 500),
  );
}

/**
 * Extracts the first balanced JSON object ({...}) from a string.
 * Handles nested braces, string literals with escaped chars, etc.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // Unbalanced braces
}

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly rawContent: string,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Retries an async operation with exponential backoff.
 * Used by all pipeline stages to handle transient LLM API errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on client errors (4xx) — they won't succeed on retry
      if (err instanceof LlmProviderError && err.statusCode >= 400 && err.statusCode < 500) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError ?? new Error('Unknown error in retry loop');
}
