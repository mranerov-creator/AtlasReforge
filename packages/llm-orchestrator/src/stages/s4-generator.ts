/**
 * Stage 4 — Code Generator
 *
 * The most expensive stage. Uses claude-sonnet-4-6 with:
 *   - The full RAG context from S3 (Atlassian docs injected as authoritative reference)
 *   - The enriched dependency metadata from S2 (business context)
 *   - The original script content (sanitized)
 *   - Strict output schema with FieldMappingPlaceholders
 *
 * Generates:
 *   - FOR FORGE: manifest.yml + resolver + handler + optional frontend
 *   - FOR SCRIPTRUNNER: Groovy script ready for SR Cloud
 *   - ALWAYS: Mermaid sequence diagram of the new async flow
 *   - ALWAYS: per-block confidence scores
 *
 * Input:  ParsedScriptShell + S1 + S2 + S3
 * Output: S4GeneratorOutput
 */

import type { ParsedScriptShell } from '@atlasreforge/parser';
import {
  S4_FORGE_GENERATOR_SYSTEM_PROMPT,
  S4_SR_CLOUD_GENERATOR_SYSTEM_PROMPT,
  S4_SIL_TO_FORGE_SYSTEM_PROMPT,
} from '../meta-prompts/prompts.js';
import { parseJsonResponse, withRetry } from '../providers/llm.providers.js';
import type {
  BlockConfidence,
  CodeConfidenceMap,
  FieldMappingPlaceholder,
  GeneratedDiagram,
  GeneratedFile,
  LlmProvider,
  RagDocument,
  S1ClassifierOutput,
  S2ExtractionOutput,
  S3RetrievalOutput,
  S4GeneratorOutput,
} from '../types/pipeline.types.js';

// ─── RAG context formatter ────────────────────────────────────────────────────

function formatRagContext(docs: ReadonlyArray<RagDocument>): string {
  if (docs.length === 0) {
    return '(No RAG documents retrieved — generate code from training knowledge only)';
  }

  return docs
    .slice(0, 8) // Hard cap — avoid context overflow
    .map((doc, i) => `
[DOC ${i + 1}] ${doc.title}
Source: ${doc.source}
Relevance: ${(doc.similarity * 100).toFixed(0)}%
---
${doc.content.slice(0, 800)}`)
    .join('\n\n');
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildGeneratorUserMessage(
  parsedScript: ParsedScriptShell,
  rawScriptContent: string,
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
  retrievalOutput: S3RetrievalOutput,
): string {
  const ragContext = formatRagContext(retrievalOutput.documents);

  const businessContext = `
BUSINESS LOGIC SUMMARY:
- Trigger: ${extractionOutput.businessLogicSummary.triggerDescription}
- Purpose: ${extractionOutput.businessLogicSummary.purposeNarrative}
- Input conditions: ${extractionOutput.businessLogicSummary.inputConditions.join('; ') || 'none'}
- Output actions: ${extractionOutput.businessLogicSummary.outputActions.join('; ') || 'none'}
- External integrations: ${extractionOutput.businessLogicSummary.externalIntegrations.join(', ') || 'none'}

ENRICHED DEPENDENCIES:
${extractionOutput.enrichedCustomFields.map(cf =>
  `- customfield ${cf.fieldId}: "${cf.probableBusinessPurpose}" → placeholder: ATLAS_FIELD_ID("${cf.fieldId}")`
).join('\n') || '(none)'}

${extractionOutput.enrichedGroups.map(g =>
  `- group "${g.groupName}": ${g.probableRole} → Cloud pattern: ${g.cloudEquivalentPattern}`
).join('\n') || '(no groups)'}

${extractionOutput.enrichedUserRefs.map(u =>
  `- user "${u.identifier}" (${u.gdprRisk} GDPR risk) → ${u.resolutionStrategy}`
).join('\n') || '(no user refs)'}

MIGRATION TARGET: ${classifierOutput.migrationTarget}
MODULE TYPE: ${classifierOutput.moduleType}${
  parsedScript.workflowContext !== null
    ? `

WORKFLOW XML CONTEXT (this script was extracted from a Jira workflow XML export):
- Workflow name:  ${parsedScript.workflowContext.workflowName}
- Transition:     ${parsedScript.workflowContext.transitionName}
- From status:    ${parsedScript.workflowContext.fromStatus ?? 'any'}
- To status:      ${parsedScript.workflowContext.toStatus ?? 'any'}
- Script ${parsedScript.workflowContext.scriptIndex + 1} of ${parsedScript.workflowContext.totalScriptsInWorkflow} extracted from this workflow

Use the transition context to make the generated manifest.yml and handler more specific:
use the transition name in comments, use fromStatus/toStatus in validator logic, and name
the Forge module key after the transition (e.g. "${parsedScript.workflowContext.transitionName.toLowerCase().replace(/\s+/g, '-')}-handler").`
    : ''
}`.trim();

  const sanitizedContent = rawScriptContent
    .replace(/<\/legacy_code>/gi, '</ legacy_code>')
    .slice(0, 10_000);

  return `
ATLASSIAN DOCUMENTATION CONTEXT (authoritative — use this, not training knowledge):
${ragContext}

${businessContext}

<legacy_code filename="${parsedScript.originalFilename}" language="${parsedScript.language}">
${sanitizedContent}
</legacy_code>

Generate the complete Cloud migration. Return ONLY the JSON object.`.trim();
}

// ─── Response parsing ─────────────────────────────────────────────────────────

interface RawS4Response {
  forgeFiles?: Array<{
    filename: string;
    content: string;
    language: string;
    purpose: string;
  }> | null;
  scriptRunnerCode?: {
    filename: string;
    content: string;
    language: string;
    purpose: string;
  } | null;
  oauthScopes: string[];
  diagram: {
    type: string;
    mermaidSource: string;
    title: string;
  };
  confidence: {
    fieldMapping: { score: number; note: string; requiresHumanReview: boolean };
    webhookLogic: { score: number; note: string; requiresHumanReview: boolean };
    userResolution: { score: number; note: string; requiresHumanReview: boolean };
    oauthScopes: { score: number; note: string; requiresHumanReview: boolean };
    overallMigration: { score: number; note: string; requiresHumanReview: boolean };
  };
  fieldMappingPlaceholders: Array<{
    placeholder: string;
    serverFieldId: string;
    description: string;
    requiredInFile: string;
  }>;
}

function parseBlockConfidence(raw: {
  score: number;
  note: string;
  requiresHumanReview: boolean;
} | undefined): BlockConfidence {
  return {
    score: Math.min(1, Math.max(0, raw?.score ?? 0.5)),
    note: raw?.note ?? '',
    requiresHumanReview: raw?.requiresHumanReview ?? true,
  };
}

function buildFallbackDiagram(moduleType: string): GeneratedDiagram {
  return {
    type: 'sequenceDiagram',
    title: `${moduleType} — Cloud Migration Flow`,
    mermaidSource: `sequenceDiagram
    participant U as User
    participant J as Jira Cloud
    participant F as Forge Function
    participant A as External API
    U->>J: Trigger (${moduleType})
    J->>F: Invoke via webhook
    F->>J: requestJira() REST API v3
    F->>A: fetch() Forge Egress
    A-->>F: Response
    F-->>J: Update issue`,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runS4Generator(
  parsedScript: ParsedScriptShell,
  rawScriptContent: string,
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
  retrievalOutput: S3RetrievalOutput,
  generatorProvider: LlmProvider,
  maxRetries: number,
): Promise<S4GeneratorOutput> {
  // Triary prompt selector:
  //   SIL scripts  → dedicated SIL→Forge prompt (SIL has no Cloud equivalent from Appfire)
  //   scriptrunner-cloud → ScriptRunner Cloud Groovy prompt
  //   everything else    → standard Forge prompt
  const isSilScript = classifierOutput.language === 'sil';
  const isScriptRunner = classifierOutput.migrationTarget === 'scriptrunner-cloud';

  const systemPrompt = isSilScript
    ? S4_SIL_TO_FORGE_SYSTEM_PROMPT
    : isScriptRunner
      ? S4_SR_CLOUD_GENERATOR_SYSTEM_PROMPT
      : S4_FORGE_GENERATOR_SYSTEM_PROMPT;

  const userMessage = buildGeneratorUserMessage(
    parsedScript,
    rawScriptContent,
    classifierOutput,
    extractionOutput,
    retrievalOutput,
  );

  // Token budget: complex scripts can need up to 4000 output tokens
  const maxTokens = Math.min(
    4000,
    classifierOutput.estimatedPipelineCost.s4GeneratorTokens,
  );

  const raw = await withRetry(
    () => generatorProvider.complete({
      systemPrompt,
      userMessage,
      maxTokens,
      temperature: 0.2, // Small amount of variation — still grounded
      jsonMode: false,  // Anthropic doesn't have a JSON mode — we parse manually
    }),
    maxRetries,
  );

  let parsed: RawS4Response;
  try {
    parsed = parseJsonResponse<RawS4Response>(raw.content);
  } catch {
    // If JSON parsing fails, return a structured error with a fallback diagram
    return {
      forgeFiles: null,
      scriptRunnerCode: null,
      diagram: buildFallbackDiagram(classifierOutput.moduleType),
      oauthScopes: [],
      confidence: buildFallbackConfidence(),
      fieldMappingPlaceholders: [],
      tokensUsed: raw.tokensUsed,
      modelUsed: raw.modelId,
    };
  }

  // Parse forge files
  const forgeFiles: GeneratedFile[] | null = parsed.forgeFiles
    ? parsed.forgeFiles.map((f) => ({
        filename: f.filename,
        content: f.content,
        language: (f.language as GeneratedFile['language']) ?? 'typescript',
        purpose: f.purpose,
      }))
    : null;

  // Parse SR code
  const scriptRunnerCode: GeneratedFile | null = parsed.scriptRunnerCode
    ? {
        filename: parsed.scriptRunnerCode.filename,
        content: parsed.scriptRunnerCode.content,
        language: 'groovy',
        purpose: parsed.scriptRunnerCode.purpose,
      }
    : null;

  // Parse diagram
  const diagram: GeneratedDiagram = parsed.diagram
    ? {
        type: (parsed.diagram.type as GeneratedDiagram['type']) ?? 'sequenceDiagram',
        mermaidSource: parsed.diagram.mermaidSource,
        title: parsed.diagram.title,
      }
    : buildFallbackDiagram(classifierOutput.moduleType);

  // Parse confidence
  const confidence: CodeConfidenceMap = {
    fieldMapping: parseBlockConfidence(parsed.confidence?.fieldMapping),
    webhookLogic: parseBlockConfidence(parsed.confidence?.webhookLogic),
    userResolution: parseBlockConfidence(parsed.confidence?.userResolution),
    oauthScopes: parseBlockConfidence(parsed.confidence?.oauthScopes),
    overallMigration: parseBlockConfidence(parsed.confidence?.overallMigration),
  };

  // Parse placeholders
  const fieldMappingPlaceholders: FieldMappingPlaceholder[] = (
    parsed.fieldMappingPlaceholders ?? []
  ).map((p) => ({
    placeholder: p.placeholder,
    serverFieldId: p.serverFieldId,
    description: p.description,
    requiredInFile: p.requiredInFile,
  }));

  return {
    forgeFiles,
    scriptRunnerCode,
    diagram,
    oauthScopes: parsed.oauthScopes ?? [],
    confidence,
    fieldMappingPlaceholders,
    tokensUsed: raw.tokensUsed,
    modelUsed: raw.modelId,
  };
}

function buildFallbackConfidence(): CodeConfidenceMap {
  const fallback: BlockConfidence = {
    score: 0,
    note: 'Code generation failed — JSON parse error',
    requiresHumanReview: true,
  };
  return {
    fieldMapping: fallback,
    webhookLogic: fallback,
    userResolution: fallback,
    oauthScopes: fallback,
    overallMigration: fallback,
  };
}
