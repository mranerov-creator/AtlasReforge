/**
 * AST Strategy
 *
 * Uses tree-sitter grammars for Java and Groovy.
 * Applied when: language is Java, or Groovy WITHOUT heavy metaprogramming.
 *
 * NOTE: tree-sitter is loaded lazily to avoid startup cost when other
 * strategies are selected. The parser is cached after first init.
 */

import type { ParsedScriptShell } from '../types/parsed-script.types.js';
import type { StrategyInput, StrategyOutput } from './strategy.interface.js';

// tree-sitter is loaded dynamically to support both Node and WASM environments
let parserInitialized = false;

/**
 * Returns whether the AST strategy can handle the given input.
 * Java: always. Groovy: only if no metaprogramming indicators.
 */
export function canHandleAst(input: StrategyInput): boolean {
  if (input.language === 'java') return true;
  if (input.language === 'groovy') {
    return !hasHeavyMetaprogramming(input.content);
  }
  return false;
}

/**
 * Heuristics for Groovy metaprogramming patterns that defeat static AST analysis.
 * If any of these fire, we fall back to HybridStrategy.
 */
function hasHeavyMetaprogramming(content: string): boolean {
  const METAPROGRAMMING_SIGNALS = [
    /\.metaClass\b/,
    /ExpandoMetaClass/,
    /methodMissing/,
    /propertyMissing/,
    /invokeMethod/,
    /\@CompileStatic/,     // Ironic: @CompileStatic *hints* at dynamic code nearby
    /use\s*\([A-Z]\w+\s*\)\s*\{/,  // Groovy category usage
    /mixin\s*\(/,
    /\.&\w+/,              // Method reference — dynamic dispatch
  ];
  return METAPROGRAMMING_SIGNALS.some((p) => p.test(content));
}

export async function runAstStrategy(
  input: StrategyInput,
): Promise<StrategyOutput> {
  // tree-sitter integration is environment-sensitive.
  // In CI/test environments without native bindings, we gracefully degrade.
  try {
    // Dynamic import — only load when actually needed
    const Parser = await import('tree-sitter').then((m) => m.default);

    const grammarModule =
      input.language === 'java'
        ? await import('tree-sitter-java').then((m) => m.default)
        : await import('tree-sitter-groovy').then((m) => m.default);

    const parser = new Parser();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    parser.setLanguage(grammarModule as any);

    const tree = parser.parse(input.content);

    // AST-based extraction enhances the regex-based DependencyMap
    // by providing structural context (e.g., whether a field access is
    // inside a method argument vs a string literal)
    const astEnhancements = extractAstEnhancements(tree, input.content);

    return {
      strategy: 'ast',
      astCoverage: 0.95,
      llmTokensUsed: null,
      enhancements: astEnhancements,
    };
  } catch (err) {
    // tree-sitter native binding unavailable — return empty enhancements
    // The dependency extractor's regex results still stand
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      strategy: 'ast',
      astCoverage: 0.0,
      llmTokensUsed: null,
      enhancements: {},
      fallbackReason: `tree-sitter unavailable: ${errorMessage}`,
    };
  }
}

interface AstEnhancements extends Record<string, unknown> {
  readonly methodCallCount?: number;
  readonly classCount?: number;
  readonly closureDepth?: number;
  readonly hasMainMethod?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAstEnhancements(tree: any, _content: string): AstEnhancements {
  let methodCallCount = 0;
  let classCount = 0;
  let closureDepth = 0;

  // Walk the CST and count structural elements
  // tree-sitter's rootNode gives us the full CST
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any, depth: number): void {
    if (node.type === 'method_invocation' || node.type === 'call_expression') {
      methodCallCount++;
    }
    if (node.type === 'class_declaration') {
      classCount++;
    }
    if (node.type === 'closure' || node.type === 'lambda_expression') {
      closureDepth = Math.max(closureDepth, depth);
    }
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      walk(node.child(i), depth + 1);
    }
  }

  walk(tree.rootNode, 0);

  return {
    methodCallCount,
    classCount,
    closureDepth,
    hasMainMethod: methodCallCount > 0 && classCount > 0,
  };
}
