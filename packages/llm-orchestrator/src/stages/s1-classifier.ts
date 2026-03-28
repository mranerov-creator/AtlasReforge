/**
 * Stage 1 — Classifier
 *
 * The cheapest stage in the pipeline. Uses GPT-4o-mini to classify
 * the script type and estimate the cost of the remaining stages.
 *
 * This runs FIRST — if classification fails or gives very low confidence,
 * we can abort early before spending tokens on S2-S4.
 *
 * Input:  ParsedScriptShell (parser output)
 * Output: S1ClassifierOutput (classification + cost estimate)
 */

import type { ParsedScriptShell } from '@atlasreforge/parser';
import { S1_CLASSIFIER_SYSTEM_PROMPT } from '../meta-prompts/prompts.js';
import { parseJsonResponse, withRetry } from '../providers/llm.providers.js';
import type {
  LlmProvider,
  PipelineCostEstimate,
  S1ClassifierOutput,
} from '../types/pipeline.types.js';

// Approximate cost per 1M tokens (USD) — update as pricing changes
const COST_PER_1M_TOKENS: Record<string, number> = {
  'gpt-4o-mini': 0.15,
  'claude-sonnet-4-6': 3.0,
  'claude-haiku-4-5-20251001': 0.25,
};

interface RawS1Response {
  moduleType: string;
  triggerEvent: string;
  complexity: string;
  migrationTarget: string;
  requiresFieldMappingRegistry: boolean;
  requiresUserMigration: boolean;
  hasExternalIntegrations: boolean;
  estimatedS4Tokens: number;
  classificationRationale: string;
}

function buildCostEstimate(
  classifierModel: string,
  generatorModel: string,
  estimatedS4Tokens: number,
): PipelineCostEstimate {
  const classifierCost = COST_PER_1M_TOKENS[classifierModel] ?? 0.15;
  const generatorCost = COST_PER_1M_TOKENS[generatorModel] ?? 3.0;

  // S2: ~400 tokens input + 600 output
  const s2Tokens = 1000;
  // S3: no LLM — just vector DB retrieval
  const s3DocCount = 8;
  // S4: estimated by classifier + ~400 tokens input overhead
  const s4Total = estimatedS4Tokens + 400;
  // S5: no LLM

  const totalTokens = 500 + s2Tokens + s4Total; // S1 + S2 + S4
  const totalCostUsd =
    ((500 * classifierCost) / 1_000_000) +
    ((s2Tokens * classifierCost) / 1_000_000) +
    ((s4Total * generatorCost) / 1_000_000);

  return {
    s2ExtractorTokens: s2Tokens,
    s3RetrievalDocCount: s3DocCount,
    s4GeneratorTokens: s4Total,
    totalEstimatedUsd: Math.round(totalCostUsd * 10000) / 10000,
  };
}

/**
 * Sanitizes script content before injection into the classifier prompt.
 * Prevents XML tag injection from malicious script comments.
 */
function sanitizeForPrompt(content: string): string {
  return content
    .replace(/<\/script>/gi, '</ script>')
    .slice(0, 6000);  // S1 only needs a sample — not the full script
}

export async function runS1Classifier(
  parsedScript: ParsedScriptShell,
  classifierProvider: LlmProvider,
  generatorModelId: string,
  maxRetries: number,
): Promise<S1ClassifierOutput> {
  // Build a compact representation for the classifier
  // We don't send the full script — just the first 6000 chars and key signals
  const scriptSample = sanitizeForPrompt(
    // We don't have raw content here — reconstruct signals from ParsedScript
    buildSignalSummary(parsedScript),
  );

  const userMessage = `
Classify this Atlassian Server/DC automation script.

PRE-ANALYSIS SIGNALS (from static analysis):
- Detected language: ${parsedScript.language} (confidence: ${parsedScript.languageConfidence})
- Detected module type: ${parsedScript.moduleType}
- Lines of code: ${parsedScript.linesOfCode}
- Custom fields detected: ${parsedScript.dependencies.customFields.length}
- Groups detected: ${parsedScript.dependencies.groups.length}
- Username refs (GDPR): ${parsedScript.dependencies.users.length}
- Deprecated API calls: ${parsedScript.dependencies.deprecatedApis.length}
- External HTTP calls: ${parsedScript.dependencies.externalHttpCalls.length}
- Script dependencies: ${parsedScript.dependencies.scriptDependencies.length}
- Cloud readiness score: ${parsedScript.cloudReadiness.score}/100
- Deprecated API reasons: ${[...new Set(parsedScript.dependencies.deprecatedApis.map((a: { deprecationReason: string }) => a.deprecationReason))].join(', ') || 'none'}

<script filename="${parsedScript.originalFilename}">
${scriptSample}
</script>

Return ONLY the JSON classification object.`.trim();

  const raw = await withRetry(
    () => classifierProvider.complete({
      systemPrompt: S1_CLASSIFIER_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 400,
      temperature: 0.0,
      jsonMode: true,
    }),
    maxRetries,
  );

  const parsed = parseJsonResponse<RawS1Response>(raw.content);
  const costEstimate = buildCostEstimate(
    classifierProvider.modelId,
    generatorModelId,
    parsed.estimatedS4Tokens ?? 1000,
  );

  return {
    language: parsedScript.language,
    moduleType: (parsed.moduleType as S1ClassifierOutput['moduleType']) ?? parsedScript.moduleType,
    triggerEvent: (parsed.triggerEvent as S1ClassifierOutput['triggerEvent']) ?? parsedScript.triggerEvent,
    complexity: (parsed.complexity as S1ClassifierOutput['complexity']) ?? parsedScript.complexity,
    migrationTarget: (parsed.migrationTarget as S1ClassifierOutput['migrationTarget'])
      ?? parsedScript.cloudReadiness.recommendedMigrationTarget,
    requiresFieldMappingRegistry: parsed.requiresFieldMappingRegistry
      ?? parsedScript.dependencies.customFields.length > 0,
    requiresUserMigration: parsed.requiresUserMigration
      ?? parsedScript.dependencies.users.length > 0,
    hasExternalIntegrations: parsed.hasExternalIntegrations
      ?? parsedScript.dependencies.externalHttpCalls.length > 0,
    estimatedPipelineCost: costEstimate,
    tokensUsed: raw.tokensUsed,
  };
}

/**
 * Builds a compact signal summary from the ParsedScriptShell.
 * S1 doesn't need the full script — just the key signals.
 */
function buildSignalSummary(script: ParsedScriptShell): string {
  const lines: string[] = [
    `File: ${script.originalFilename}`,
    `Language: ${script.language}`,
    `Module: ${script.moduleType}`,
    `LOC: ${script.linesOfCode}`,
    '',
    '// Key dependencies detected:',
  ];

  for (const cf of script.dependencies.customFields.slice(0, 5)) {
    lines.push(`getCustomFieldObject("${cf.fieldId}") // ${cf.usageType}`);
  }
  for (const g of script.dependencies.groups.slice(0, 3)) {
    lines.push(`getGroup("${g.groupName}")`);
  }
  for (const u of script.dependencies.users.slice(0, 3)) {
    lines.push(`getUserByName("${u.identifier}") // GDPR risk`);
  }
  for (const d of script.dependencies.deprecatedApis.slice(0, 5)) {
    lines.push(`${d.apiClass} // deprecated: ${d.deprecationReason}`);
  }
  for (const h of script.dependencies.externalHttpCalls.slice(0, 2)) {
    lines.push(`HTTP ${h.method} ${h.url ?? 'dynamic'}`);
  }

  return lines.join('\n');
}
