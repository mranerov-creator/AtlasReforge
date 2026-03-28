/**
 * Language Detector — Multi-signal scoring engine
 *
 * Strategy: no single signal determines language. We compute a weighted score
 * across N independent signals and pick the winner above a threshold.
 * This prevents false positives on polyglot files (e.g. Groovy with Java imports).
 */

import type {
  ScriptLanguage,
  ScriptLanguageConfidence,
} from '../types/parsed-script.types.js';

// ─── Signal weights ────────────────────────────────────────────────────────────

const WEIGHTS = {
  FILE_EXTENSION: 40,   // Highest signal — explicit file extension
  SYNTAX_PATTERN: 30,   // Language-specific syntax patterns
  IMPORT_PATTERN: 20,   // Import/package declarations
  API_PATTERN: 10,      // Atlassian-specific API patterns
} as const;

const CONFIDENCE_THRESHOLDS = {
  HIGH: 70,    // Score >= 70: high confidence
  MEDIUM: 40,  // Score >= 40: medium confidence
  LOW: 0,      // Score >= 0: low confidence (fallback)
} as const;

// ─── Signal definitions ────────────────────────────────────────────────────────

interface SignalSet {
  readonly syntax: ReadonlyArray<RegExp>;
  readonly imports: ReadonlyArray<RegExp>;
  readonly atlassianApis: ReadonlyArray<RegExp>;
  readonly negativeSignals: ReadonlyArray<RegExp>; // Patterns that EXCLUDE this language
}

const SIGNALS: Record<Exclude<ScriptLanguage, 'unknown' | 'workflow-xml'>, SignalSet> = {
  groovy: {
    syntax: [
      /\bdef\s+\w+\s*[=({]/,             // def keyword (Groovy idiom, not Java)
      /\bdef\s+\w+\s*=\s*\[/,            // Groovy list literal: def x = [...]
      /\[.*\]\.each\s*\{/,               // Groovy each closure
      /\bclosure\s*=\s*\{/,              // Closure assignment
      /\bimport\s+com\.onresolve/,        // ScriptRunner package
      /\.collect\s*\{/,                  // Groovy collect
      /\.findAll\s*\{/,                  // Groovy findAll
      /\b@\w+\s*\(.*\)\s*$/m,            // Groovy annotations
      /\bString\[\]\s+\w+\s*=/,          // Groovy array syntax
      /\bGroovyShell\b/,
    ],
    imports: [
      /^import\s+com\.atlassian\./m,
      /^import\s+com\.onresolve\./m,
      /^import\s+groovy\./m,
      /^import\s+org\.codehaus\.groovy\./m,
    ],
    atlassianApis: [
      /\bComponentAccessor\b/,
      /\bIssueManager\b/,
      /\bUserManager\b/,
      /\bGroupManager\b/,
      /\bCustomFieldManager\b/,
      /\bWorkflowManager\b/,
      /\bScriptRunner\b/,
      /\.getCustomFieldObject\(/,
      /\bMutableIssue\b/,
    ],
    negativeSignals: [
      /^public\s+class\s+\w+/m,          // Strongly Java if class declaration
      /\breturn\s+new\s+\w+Builder\(/,    // Java builder pattern
    ],
  },

  java: {
    syntax: [
      /^public\s+class\s+\w+/m,
      /^public\s+(static\s+)?void\s+main\s*\(/m,
      /\b@Override\b/,
      /\bnew\s+\w+\(.*\);/,              // Java constructor with semicolon
      /\bprivate\s+final\s+/,
      /\bpublic\s+interface\s+\w+/m,
      /\bimplements\s+\w+/,
      /\bextends\s+\w+/,
      /\bthrows\s+\w+Exception\b/,
    ],
    imports: [
      /^import\s+java\./m,
      /^import\s+javax\./m,
      /^package\s+com\.\w+/m,
      /^import\s+org\.springframework\./m,
    ],
    atlassianApis: [
      /\bComponentAccessor\.getComponent\(/,
      /\bAtlassianComponentPlugin\b/,
      /\bActiveObjects\b/,
      /\bPluginAccessor\b/,
    ],
    negativeSignals: [
      /\bdef\s+\w+\s*=/,                 // def is Groovy
      /\.each\s*\{/,                     // Groovy closure iteration
    ],
  },

  sil: {
    syntax: [
      /^runAs\s*\(/m,                    // SIL runAs
      /^setFieldValue\s*\(/m,            // SIL field setter
      /^getFieldValue\s*\(/m,            // SIL field getter
      /^sendEmail\s*\(/m,                // SIL email
      /^createIssue\s*\(/m,              // SIL issue creation
      /\bstringToDate\s*\(/,             // SIL date conversion
      /\bgetProjectField\s*\(/,          // SIL project field
      /\bgetIssues\s*\(/,                // SIL issue search
      /\bworkflowAction\s*\(/,           // SIL workflow
      /\bproject\s*=\s*"[A-Z]+"/,        // SIL project key assignment (uppercase)
      /\/\/.*SIL/i,                      // SIL comment marker
      /^#SIL\b/m,                        // SIL shebang-style
    ],
    imports: [
      /^include\s+"[\w/]+\.sil"/m,       // SIL include statement
      /^require\s+"[\w/]+\.sil"/m,
    ],
    atlassianApis: [
      /\bgetIssueField\s*\(/,
      /\bsetIssueField\s*\(/,
      /\bgetAssignee\s*\(/,
      /\bgetReporter\s*\(/,
      /\bgetCurrentUser\s*\(/,
      /\bgetCustomField\s*\(/,
    ],
    negativeSignals: [
      /^import\s+/m,                     // SIL doesn't use import keyword
      /\bdef\s+\w+/,                     // Not SIL syntax
      /\bpublic\s+class\b/,
    ],
  },
};

// ─── Extension map ────────────────────────────────────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, ScriptLanguage> = {
  '.groovy': 'groovy',
  '.java': 'java',
  '.sil': 'sil',
  '.SIL': 'sil',
} as const;

// ─── Scorer ───────────────────────────────────────────────────────────────────

interface LanguageScore {
  readonly language: ScriptLanguage;
  readonly score: number;
  readonly matchedSignals: ReadonlyArray<string>;
}

function scoreLanguage(
  content: string,
  language: Exclude<ScriptLanguage, 'unknown'>,
  signals: SignalSet,
): LanguageScore {
  const matchedSignals: string[] = [];
  let score = 0;

  // Syntax signals
  let syntaxHits = 0;
  for (const pattern of signals.syntax) {
    if (pattern.test(content)) {
      syntaxHits++;
      matchedSignals.push(`syntax:${pattern.source.slice(0, 30)}`);
    }
  }
  // Diminishing returns — first hit counts full, additional hits are partial
  if (syntaxHits > 0) {
    score += WEIGHTS.SYNTAX_PATTERN * Math.min(1, 0.4 + syntaxHits * 0.2);
  }

  // Import signals
  let importHits = 0;
  for (const pattern of signals.imports) {
    if (pattern.test(content)) {
      importHits++;
      matchedSignals.push(`import:${pattern.source.slice(0, 30)}`);
    }
  }
  if (importHits > 0) {
    score += WEIGHTS.IMPORT_PATTERN * Math.min(1, importHits * 0.5);
  }

  // Atlassian API signals
  let apiHits = 0;
  for (const pattern of signals.atlassianApis) {
    if (pattern.test(content)) {
      apiHits++;
      matchedSignals.push(`api:${pattern.source.slice(0, 30)}`);
    }
  }
  if (apiHits > 0) {
    score += WEIGHTS.API_PATTERN * Math.min(1, apiHits * 0.3);
  }

  // Negative signals — deduct score
  for (const pattern of signals.negativeSignals) {
    if (pattern.test(content)) {
      score -= 15;
      matchedSignals.push(`negative:${pattern.source.slice(0, 30)}`);
    }
  }

  return {
    language,
    score: Math.max(0, score),
    matchedSignals,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LanguageDetectionResult {
  readonly language: ScriptLanguage;
  readonly confidence: ScriptLanguageConfidence;
  readonly score: number;
  readonly scores: ReadonlyArray<LanguageScore>;
  readonly detectedViaExtension: boolean;
}

/**
 * Detects the scripting language of an Atlassian Server/DC script.
 *
 * @param content - Raw script content
 * @param filename - Optional filename for extension-based boosting
 */
export function detectLanguage(
  content: string,
  filename?: string,
): LanguageDetectionResult {
  const normalizedContent = content.trim();

  if (normalizedContent.length === 0) {
    return {
      language: 'unknown',
      confidence: 'low',
      score: 0,
      scores: [],
      detectedViaExtension: false,
    };
  }

  // Extension fast-path: if extension maps cleanly, use it as a strong prior
  let extensionBonus: { language: ScriptLanguage; bonus: number } | null = null;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.'));
    const extLang = EXTENSION_LANGUAGE_MAP[ext];
    if (extLang !== undefined && extLang !== 'unknown') {
      extensionBonus = { language: extLang, bonus: WEIGHTS.FILE_EXTENSION };
    }
  }

  // Score all candidate languages
  const scores: LanguageScore[] = (
    Object.entries(SIGNALS) as Array<
      [Exclude<ScriptLanguage, 'unknown'>, SignalSet]
    >
  ).map(([lang, signals]) => {
    const base = scoreLanguage(normalizedContent, lang, signals);
    // Apply extension bonus if it matches this language
    const bonus =
      extensionBonus?.language === lang ? extensionBonus.bonus : 0;
    return { ...base, score: base.score + bonus };
  });

  // Sort descending by score
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const winner = sorted[0];

  // Require minimum signal to avoid misclassification of very short scripts
  if (winner === undefined || winner.score < 5) {
    return {
      language: 'unknown',
      confidence: 'low',
      score: 0,
      scores: sorted,
      detectedViaExtension: false,
    };
  }

  const confidence = resolveConfidence(winner.score, sorted);

  return {
    language: winner.language,
    confidence,
    score: winner.score,
    scores: sorted,
    detectedViaExtension: extensionBonus?.language === winner.language,
  };
}

function resolveConfidence(
  winnerScore: number,
  sorted: ReadonlyArray<LanguageScore>,
): ScriptLanguageConfidence {
  // If second place is close to first, lower confidence
  const secondScore = sorted[1]?.score ?? 0;
  const margin = winnerScore - secondScore;

  if (winnerScore >= CONFIDENCE_THRESHOLDS.HIGH && margin >= 20) {
    return 'high';
  }
  if (winnerScore >= CONFIDENCE_THRESHOLDS.MEDIUM && margin >= 10) {
    return 'medium';
  }
  return 'low';
}
