/**
 * Stage 2 — Structured Extractor
 *
 * Takes the ParsedScriptShell + S1 classification and uses LLM to add
 * semantic business context that pure regex/AST can't capture:
 * - What does customfield_10048 represent in business terms?
 * - What is the purpose of the "jira-finance-team-PROD" group check?
 * - Which patterns in this script match known Forge/SR migration patterns?
 *
 * The patterns detected here drive S3 RAG queries — precise pattern IDs
 * produce more targeted retrieval than raw script content.
 *
 * Input:  ParsedScriptShell + S1ClassifierOutput
 * Output: S2ExtractionOutput
 */

import type { ParsedScriptShell } from '@atlasreforge/parser';
import { S2_EXTRACTOR_SYSTEM_PROMPT } from '../meta-prompts/prompts.js';
import { parseJsonResponse, withRetry } from '../providers/llm.providers.js';
import type {
  LlmProvider,
  S1ClassifierOutput,
  S2ExtractionOutput,
} from '../types/pipeline.types.js';

interface RawS2Response {
  enrichedCustomFields: Array<{
    fieldId: string;
    probableBusinessPurpose: string;
    usageType: string;
    suggestedForgeStorageKey: string;
    requiresFieldMappingRegistry: boolean;
  }>;
  enrichedGroups: Array<{
    groupName: string;
    probableRole: string;
    cloudEquivalentPattern: string;
  }>;
  enrichedUserRefs: Array<{
    identifier: string;
    identifierType: string;
    gdprRisk: string;
    resolutionStrategy: string;
  }>;
  businessLogicSummary: {
    triggerDescription: string;
    purposeNarrative: string;
    inputConditions: string[];
    outputActions: string[];
    externalIntegrations: string[];
  };
  detectedPatterns: Array<{
    patternId: string;
    description: string;
    relevantRagQuery: string;
  }>;
}

function sanitizeContent(content: string): string {
  return content
    .replace(/<\/script>/gi, '</ script>')
    .slice(0, 8000);
}

function buildDependencySummary(script: ParsedScriptShell): string {
  const parts: string[] = [];

  if (script.dependencies.customFields.length > 0) {
    parts.push('CUSTOM FIELDS DETECTED:');
    for (const cf of script.dependencies.customFields) {
      parts.push(`  - ${cf.fieldId} (${cf.usageType}): ${cf.rawExpression}`);
    }
  }

  if (script.dependencies.groups.length > 0) {
    parts.push('\nGROUPS DETECTED:');
    for (const g of script.dependencies.groups) {
      parts.push(`  - "${g.groupName}": ${g.rawExpression}`);
    }
  }

  if (script.dependencies.users.length > 0) {
    parts.push('\nUSER REFERENCES (GDPR risk):');
    for (const u of script.dependencies.users) {
      parts.push(`  - "${u.identifier}" (${u.identifierType}): ${u.rawExpression}`);
    }
  }

  if (script.dependencies.externalHttpCalls.length > 0) {
    parts.push('\nEXTERNAL HTTP CALLS:');
    for (const h of script.dependencies.externalHttpCalls) {
      parts.push(`  - ${h.method} ${h.url ?? 'dynamic URL'}`);
    }
  }

  if (script.dependencies.deprecatedApis.length > 0) {
    parts.push('\nDEPRECATED APIS:');
    for (const d of script.dependencies.deprecatedApis) {
      parts.push(`  - ${d.apiClass}: ${d.deprecationReason}`);
    }
  }

  return parts.join('\n');
}

export async function runS2Extractor(
  parsedScript: ParsedScriptShell,
  classifierOutput: S1ClassifierOutput,
  provider: LlmProvider,
  maxRetries: number,
): Promise<S2ExtractionOutput> {
  const dependencySummary = buildDependencySummary(parsedScript);

  const userMessage = `
Analyze this Atlassian Server/DC script and enrich the pre-extracted dependency metadata with business context.

CLASSIFICATION (from Stage 1):
- Module type: ${classifierOutput.moduleType}
- Trigger: ${classifierOutput.triggerEvent}
- Migration target: ${classifierOutput.migrationTarget}
- Complexity: ${classifierOutput.complexity}
- Requires Field Mapping Registry: ${String(classifierOutput.requiresFieldMappingRegistry)}
- Requires User Migration (GDPR): ${String(classifierOutput.requiresUserMigration)}

PRE-EXTRACTED DEPENDENCIES:
${dependencySummary || '(no hardcoded dependencies found)'}

<script filename="${parsedScript.originalFilename}">
${sanitizeContent(
  // Reconstruct readable version from signals — we don't store raw content
  // in the ParsedScript for security. The raw content comes from the job queue.
  `// Language: ${parsedScript.language}\n// Module: ${parsedScript.moduleType}\n// LOC: ${parsedScript.linesOfCode}\n${dependencySummary}`,
)}
</script>

Return ONLY the JSON enrichment object.`.trim();

  const raw = await withRetry(
    () => provider.complete({
      systemPrompt: S2_EXTRACTOR_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 1500,
      temperature: 0.0,
      jsonMode: true,
    }),
    maxRetries,
  );

  const parsed = parseJsonResponse<RawS2Response>(raw.content);

  return {
    enrichedCustomFields: (parsed.enrichedCustomFields ?? []).map((cf) => ({
      fieldId: cf.fieldId,
      probableBusinessPurpose: cf.probableBusinessPurpose ?? '',
      usageType: (cf.usageType as 'read' | 'write' | 'search' | 'unknown') ?? 'unknown',
      suggestedForgeStorageKey: cf.suggestedForgeStorageKey ?? cf.fieldId,
      requiresFieldMappingRegistry: cf.requiresFieldMappingRegistry ?? true,
    })),
    enrichedGroups: (parsed.enrichedGroups ?? []).map((g) => ({
      groupName: g.groupName,
      probableRole: g.probableRole ?? '',
      cloudEquivalentPattern: g.cloudEquivalentPattern ?? '',
    })),
    enrichedUserRefs: (parsed.enrichedUserRefs ?? []).map((u) => ({
      identifier: u.identifier,
      identifierType: (u.identifierType as 'username' | 'user-key' | 'email' | 'unknown') ?? 'unknown',
      gdprRisk: (u.gdprRisk as 'high' | 'medium' | 'low') ?? 'high',
      resolutionStrategy: u.resolutionStrategy ?? 'Resolve via Atlassian User Migration API',
    })),
    businessLogicSummary: {
      triggerDescription: parsed.businessLogicSummary?.triggerDescription ?? '',
      purposeNarrative: parsed.businessLogicSummary?.purposeNarrative ?? '',
      inputConditions: parsed.businessLogicSummary?.inputConditions ?? [],
      outputActions: parsed.businessLogicSummary?.outputActions ?? [],
      externalIntegrations: parsed.businessLogicSummary?.externalIntegrations ?? [],
    },
    detectedPatterns: (parsed.detectedPatterns ?? []).map((p) => ({
      patternId: p.patternId,
      description: p.description,
      relevantRagQuery: p.relevantRagQuery,
    })),
    tokensUsed: raw.tokensUsed,
  };
}
