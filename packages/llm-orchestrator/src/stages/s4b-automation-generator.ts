/**
 * Stage 4b — Automation Rule Generator
 *
 * Activated ONLY when S1 classifies migrationTarget as 'automation-native'.
 * Generates a production-ready Atlassian Cloud Automation rule JSON using
 * the S4B_AUTOMATION_GENERATOR_SYSTEM_PROMPT.
 *
 * KEY DIFFERENCES FROM S4 (Forge/SR generator):
 *   - Output is an importable Automation rule JSON, not TypeScript/Groovy files
 *   - No RAG context needed — Automation rule schema is stable and self-contained
 *   - Uses a different confidence map (triggerMapping, conditionMapping, actionMapping)
 *   - No oauthScopes (Automation rules run as the rule owner, not an OAuth app)
 *   - Significantly cheaper: output is JSON config, not executable code
 *
 * SAFETY:
 *   - Legacy code is wrapped in <legacy_code> tags and sanitized before injection
 *   - The system prompt has an explicit SECURITY block instructing the model to
 *     ignore any instructions found inside those tags (prompt injection guard)
 *
 * Input:  ParsedScriptShell + S1ClassifierOutput + S2ExtractionOutput + AutomationSuitability
 * Output: S4bGeneratorOutput
 */

import type { ParsedScriptShell } from '@atlasreforge/parser';
import { S4B_AUTOMATION_GENERATOR_SYSTEM_PROMPT } from '../meta-prompts/prompts.js';
import { parseJsonResponse, withRetry } from '../providers/llm.providers.js';
import type {
  AutomationConfidenceMap,
  BlockConfidence,
  FieldMappingPlaceholder,
  GeneratedDiagram,
  LlmProvider,
  S1ClassifierOutput,
  S2ExtractionOutput,
  S4bGeneratorOutput,
} from '../types/pipeline.types.js';
import type { AutomationRuleOutput, AutomationSuitability } from '@atlasreforge/parser';

// ─── User message builder ──────────────────────────────────────────────────────

function buildAutomationUserMessage(
  parsedScript: ParsedScriptShell,
  rawScriptContent: string,
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
  automationSuitability: AutomationSuitability,
): string {
  const businessContext = `
BUSINESS LOGIC SUMMARY:
- Trigger: ${extractionOutput.businessLogicSummary.triggerDescription}
- Purpose: ${extractionOutput.businessLogicSummary.purposeNarrative}
- Input conditions: ${extractionOutput.businessLogicSummary.inputConditions.join('; ') || 'none'}
- Output actions: ${extractionOutput.businessLogicSummary.outputActions.join('; ') || 'none'}

AUTOMATION SUITABILITY PRE-ANALYSIS:
- Mapped trigger: ${automationSuitability.mappedTrigger ?? 'unknown'}
- Mappable operations (${automationSuitability.mappableOperations.length}):
${automationSuitability.mappableOperations.map((op: { label: string; automationEquivalent: string | null }) =>
  `  · ${op.label} → Automation: ${op.automationEquivalent ?? 'TBD'}`
).join('\n') || '  (none detected)'}
- Rationale: ${automationSuitability.rationale}

CUSTOM FIELDS REQUIRING PLACEHOLDERS:
${extractionOutput.enrichedCustomFields.map((cf) =>
  `- ${cf.fieldId}: "${cf.probableBusinessPurpose}" → use placeholder: ATLAS_FIELD_ID("${cf.fieldId}")`
).join('\n') || '(none)'}

MODULE TYPE: ${classifierOutput.moduleType}
TRIGGER EVENT: ${classifierOutput.triggerEvent}
COMPLEXITY: ${classifierOutput.complexity}`.trim();

  // Sanitize legacy content — prevent prompt injection via closing tags
  const sanitizedContent = rawScriptContent
    .replace(/<\/legacy_code>/gi, '</ legacy_code>')
    .slice(0, 8_000); // Automation rules need less context than Forge generators

  return `
${businessContext}

<legacy_code filename="${parsedScript.originalFilename}" language="${parsedScript.language}">
${sanitizedContent}
</legacy_code>

Generate the complete Atlassian Cloud Automation rule JSON. Return ONLY the JSON object.`.trim();
}

// ─── Response shape ───────────────────────────────────────────────────────────

interface RawS4bResponse {
  ruleName?: string;
  ruleJson?: string;
  description?: string;
  limitations?: string[];
  postImportSteps?: string[];
  fieldMappingPlaceholders?: Array<{
    placeholder: string;
    serverFieldId: string;
    description: string;
  }>;
  confidence?: {
    triggerMapping?:   { score?: number; note?: string; requiresHumanReview?: boolean };
    conditionMapping?: { score?: number; note?: string; requiresHumanReview?: boolean };
    actionMapping?:    { score?: number; note?: string; requiresHumanReview?: boolean };
    overallMigration?: { score?: number; note?: string; requiresHumanReview?: boolean };
  };
  diagram?: {
    type?: string;
    mermaidSource?: string;
    title?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBlockConfidence(raw?: {
  score?: number;
  note?: string;
  requiresHumanReview?: boolean;
}): BlockConfidence {
  return {
    score: Math.min(1, Math.max(0, raw?.score ?? 0.5)),
    note: raw?.note ?? '',
    requiresHumanReview: raw?.requiresHumanReview ?? true,
  };
}

function buildFallbackDiagram(moduleType: string, triggerLabel: string | null): GeneratedDiagram {
  const trigger = triggerLabel ?? moduleType;
  return {
    type: 'flowchart',
    title: `${moduleType} — Cloud Automation Rule`,
    mermaidSource: `flowchart TD
    A([${trigger}]) --> B{Condition check}
    B -- passes --> C[Automation action]
    B -- fails --> D([Skip])
    C --> E([Done])`,
  };
}

function buildFallbackConfidence(note: string): AutomationConfidenceMap {
  const fallback: BlockConfidence = { score: 0, note, requiresHumanReview: true };
  return {
    triggerMapping:   fallback,
    conditionMapping: fallback,
    actionMapping:    fallback,
    overallMigration: fallback,
  };
}

function buildFallbackAutomationRule(
  moduleType: string,
  trigger: string | null,
  rationale: string,
): AutomationRuleOutput {
  const triggerType = trigger ?? 'Issue created';
  const fallbackJson = JSON.stringify({
    name: `[AtlasReforge] Migrated ${moduleType} — Review Required`,
    state: 'DISABLED',
    triggers: [
      {
        component: { type: 'jira:issue-created' },
        children: [],
        conditions: [],
      },
    ],
    components: [
      {
        component: {
          type: 'jira:log-action',
          value: { message: `AtlasReforge: Rule generation failed for ${moduleType}. Manual configuration required.` },
        },
        children: [],
        conditions: [],
      },
    ],
  }, null, 2);

  return {
    ruleName: `[AtlasReforge] Migrated ${moduleType} — Review Required`,
    ruleJson: fallbackJson,
    description: `Fallback rule — generation failed. Trigger: ${triggerType}. ${rationale}`,
    limitations: ['Rule generation failed — manual configuration required'],
    postImportSteps: [
      'Review and configure the trigger event',
      'Add appropriate conditions',
      'Configure the correct actions',
      'Enable the rule after review',
    ],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runS4bAutomationGenerator(
  parsedScript: ParsedScriptShell,
  rawScriptContent: string,
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
  automationSuitability: AutomationSuitability,
  generatorProvider: LlmProvider,
  maxRetries: number,
): Promise<S4bGeneratorOutput> {
  const userMessage = buildAutomationUserMessage(
    parsedScript,
    rawScriptContent,
    classifierOutput,
    extractionOutput,
    automationSuitability,
  );

  // Automation rules are JSON config — cheaper than full code generation
  const maxTokens = classifierOutput.complexity === 'medium' ? 2000 : 1200;

  const raw = await withRetry(
    () => generatorProvider.complete({
      systemPrompt: S4B_AUTOMATION_GENERATOR_SYSTEM_PROMPT,
      userMessage,
      maxTokens,
      temperature: 0.1, // Very low — we want deterministic, schema-conforming JSON
      jsonMode: false,
    }),
    maxRetries,
  );

  let parsed: RawS4bResponse;
  try {
    parsed = parseJsonResponse<RawS4bResponse>(raw.content);
  } catch {
    // JSON parse failure — return structured fallback, never throw
    return {
      automationRule: buildFallbackAutomationRule(
        classifierOutput.moduleType,
        automationSuitability.mappedTrigger,
        'LLM response was not valid JSON',
      ),
      diagram: buildFallbackDiagram(classifierOutput.moduleType, automationSuitability.mappedTrigger),
      confidence: buildFallbackConfidence('Code generation failed — JSON parse error'),
      fieldMappingPlaceholders: [],
      tokensUsed: raw.tokensUsed,
      modelUsed: raw.modelId,
    };
  }

  // ── Build AutomationRuleOutput ────────────────────────────────────────────

  const automationRule: AutomationRuleOutput = {
    ruleName:        parsed.ruleName        ?? `[AtlasReforge] Migrated ${classifierOutput.moduleType}`,
    ruleJson:        parsed.ruleJson        ?? '{}',
    description:     parsed.description    ?? '',
    limitations:     parsed.limitations    ?? [],
    postImportSteps: parsed.postImportSteps ?? [],
  };

  // ── Build diagram ─────────────────────────────────────────────────────────

  const diagram: GeneratedDiagram = parsed.diagram?.mermaidSource
    ? {
        type: 'flowchart',
        mermaidSource: parsed.diagram.mermaidSource,
        title: parsed.diagram.title ?? `${classifierOutput.moduleType} — Automation Rule`,
      }
    : buildFallbackDiagram(classifierOutput.moduleType, automationSuitability.mappedTrigger);

  // ── Build confidence ──────────────────────────────────────────────────────

  const confidence: AutomationConfidenceMap = {
    triggerMapping:   parseBlockConfidence(parsed.confidence?.triggerMapping),
    conditionMapping: parseBlockConfidence(parsed.confidence?.conditionMapping),
    actionMapping:    parseBlockConfidence(parsed.confidence?.actionMapping),
    overallMigration: parseBlockConfidence(parsed.confidence?.overallMigration),
  };

  // ── Build field mapping placeholders ─────────────────────────────────────

  const fieldMappingPlaceholders: FieldMappingPlaceholder[] = (
    parsed.fieldMappingPlaceholders ?? []
  ).map((p) => ({
    placeholder:    p.placeholder,
    serverFieldId:  p.serverFieldId,
    description:    p.description,
    requiredInFile: 'automation-rule.json',
  }));

  return {
    automationRule,
    diagram,
    confidence,
    fieldMappingPlaceholders,
    tokensUsed: raw.tokensUsed,
    modelUsed:  raw.modelId,
  };
}
