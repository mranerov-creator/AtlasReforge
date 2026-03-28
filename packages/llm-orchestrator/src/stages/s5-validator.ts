/**
 * Stage 5 — Auto-validator
 *
 * Deterministic, LLM-free validation of generated code.
 * Runs the same GENERATED_CODE_VALIDATION_RULES against all generated files.
 *
 * Two-pass approach:
 *   Pass 1: Detect all violations
 *   Pass 2: Auto-fix anything with an autoFixPattern (e.g. v2 → v3, .getUsername() → .accountId)
 *
 * If after auto-fix there are still ERROR-severity issues, the pipeline
 * marks the result as failed but still returns the (partially fixed) code
 * so the user can see what needs manual attention.
 *
 * Input:  S4GeneratorOutput + ParsedScriptShell
 * Output: S5ValidationOutput
 */

import {
  GENERATED_CODE_VALIDATION_RULES,
} from '../meta-prompts/prompts.js';
import type {
  GeneratedFile,
  S4GeneratorOutput,
  S5Input,
  S5ValidationIssue,
  S5ValidationOutput,
} from '../types/pipeline.types.js';

// ─── Validation pass ──────────────────────────────────────────────────────────

function validateFile(
  file: GeneratedFile,
): { issues: S5ValidationIssue[]; fixedContent: string } {
  const issues: S5ValidationIssue[] = [];
  let content = file.content;
  const lines = content.split('\n');

  for (const rule of GENERATED_CODE_VALIDATION_RULES) {
    // Check each line independently for accurate line numbers
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';

      if (!rule.pattern.test(line)) continue;

      let autoFixed = false;

      // Attempt auto-fix if rule has a fix pattern
      if (rule.autoFixPattern !== undefined && rule.autoFixReplacement !== undefined) {
        const fixedLine = line.replace(rule.autoFixPattern, rule.autoFixReplacement);
        if (fixedLine !== line) {
          lines[lineIdx] = fixedLine;
          autoFixed = true;
        }
      }

      issues.push({
        severity: rule.severity,
        code: rule.code,
        message: rule.message,
        file: file.filename,
        line: lineIdx + 1,
        autoFixed,
      });
    }
  }

  // Reconstruct content after auto-fixes
  const fixedContent = lines.join('\n');

  return { issues, fixedContent };
}

// ─── Placeholder completeness check ──────────────────────────────────────────

function checkPlaceholders(output: S4GeneratorOutput): S5ValidationIssue[] {
  const issues: S5ValidationIssue[] = [];

  // Every placeholder declared by S4 should appear in the referenced file
  for (const placeholder of output.fieldMappingPlaceholders) {
    const targetFile = [
      ...(output.forgeFiles ?? []),
      ...(output.scriptRunnerCode ? [output.scriptRunnerCode] : []),
    ].find((f) => f.filename === placeholder.requiredInFile);

    if (targetFile === undefined) {
      issues.push({
        severity: 'warning',
        code: 'VAL_050',
        message: `Placeholder "${placeholder.placeholder}" references file "${placeholder.requiredInFile}" which was not generated.`,
        file: placeholder.requiredInFile,
        line: null,
        autoFixed: false,
      });
      continue;
    }

    if (!targetFile.content.includes(placeholder.placeholder)) {
      issues.push({
        severity: 'warning',
        code: 'VAL_051',
        message: `Placeholder "${placeholder.placeholder}" declared but not found in "${placeholder.requiredInFile}".`,
        file: placeholder.requiredInFile,
        line: null,
        autoFixed: false,
      });
    }
  }

  return issues;
}

// ─── Manifest completeness check (Forge only) ────────────────────────────────

function checkForgeManifest(forgeFiles: ReadonlyArray<GeneratedFile>): S5ValidationIssue[] {
  const issues: S5ValidationIssue[] = [];

  const manifest = forgeFiles.find((f) => f.filename === 'manifest.yml');
  if (manifest === undefined) {
    issues.push({
      severity: 'error',
      code: 'VAL_060',
      message: 'manifest.yml was not generated. Forge apps require a manifest.',
      file: 'manifest.yml',
      line: null,
      autoFixed: false,
    });
    return issues;
  }

  // Check for required manifest fields
  const requiredManifestFields = ['app:', 'permissions:', 'modules:'];
  for (const field of requiredManifestFields) {
    if (!manifest.content.includes(field)) {
      issues.push({
        severity: 'warning',
        code: 'VAL_061',
        message: `manifest.yml is missing required field: "${field}"`,
        file: 'manifest.yml',
        line: null,
        autoFixed: false,
      });
    }
  }

  // Check that scopes declared in S4 appear in manifest
  return issues;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function runS5Validator(input: S5Input): S5ValidationOutput {
  const { generatorOutput } = input;

  const allFiles: GeneratedFile[] = [
    ...(generatorOutput.forgeFiles ?? []),
    ...(generatorOutput.scriptRunnerCode ? [generatorOutput.scriptRunnerCode] : []),
  ];

  if (allFiles.length === 0) {
    return {
      passed: false,
      issues: [{
        severity: 'error',
        code: 'VAL_000',
        message: 'No files were generated by Stage 4.',
        file: 'n/a',
        line: null,
        autoFixed: false,
      }],
      autoFixCount: 0,
      generatorOutput,
    };
  }

  // Pass 1 + 2: validate and auto-fix each file
  const allIssues: S5ValidationIssue[] = [];
  const fixedFiles: GeneratedFile[] = [];
  let autoFixCount = 0;

  for (const file of allFiles) {
    const { issues, fixedContent } = validateFile(file);
    allIssues.push(...issues);
    autoFixCount += issues.filter((i) => i.autoFixed).length;
    fixedFiles.push({ ...file, content: fixedContent });
  }

  // Placeholder completeness check
  allIssues.push(...checkPlaceholders(generatorOutput));

  // Forge-specific checks
  if (generatorOutput.forgeFiles !== null && generatorOutput.forgeFiles.length > 0) {
    allIssues.push(...checkForgeManifest(fixedFiles));
  }

  // Rebuild generator output with auto-fixed files
  const patchedOutput: S4GeneratorOutput = {
    ...generatorOutput,
    forgeFiles: generatorOutput.forgeFiles !== null
      ? fixedFiles.filter((f) => generatorOutput.forgeFiles!.some((of) => of.filename === f.filename))
      : null,
    scriptRunnerCode: generatorOutput.scriptRunnerCode !== null
      ? fixedFiles.find((f) => f.filename === generatorOutput.scriptRunnerCode!.filename) ?? generatorOutput.scriptRunnerCode
      : null,
  };

  const hasErrors = allIssues.some((i) => i.severity === 'error' && !i.autoFixed);

  return {
    passed: !hasErrors,
    issues: allIssues,
    autoFixCount,
    generatorOutput: patchedOutput,
  };
}
