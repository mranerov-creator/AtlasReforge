/**
 * Strategy interface shared by AST, LLM-Semantic, and Hybrid strategies.
 */

import type { ParseStrategy, ScriptLanguage } from '../types/parsed-script.types.js';

export interface StrategyInput {
  readonly content: string;
  readonly language: ScriptLanguage;
  readonly filename?: string;
}

export interface StrategyOutput {
  readonly strategy: ParseStrategy;
  readonly astCoverage: number;        // 0-1
  readonly llmTokensUsed: number | null;
  readonly enhancements: Record<string, unknown>;
  readonly fallbackReason?: string;    // Set if strategy degraded gracefully
}
