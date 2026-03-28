/**
 * Jira Workflow XML Parser
 *
 * Extracts embedded scripts from Jira workflow XML exports and returns
 * them as enriched script objects ready for the standard AtlasReforge pipeline.
 *
 * WHY THIS EXISTS:
 *   ScriptRunner and Power Scripts scripts rarely live as standalone .groovy/.sil
 *   files — they are embedded inside Jira workflow configurations. Jira allows
 *   exporting workflows as XML. This parser unwraps those XMLs and produces one
 *   ExtractedWorkflowScript per embedded script, preserving the full transition
 *   context (workflow name, transition, from/to status, script type).
 *
 * SUPPORTED SCRIPT TYPES INSIDE WORKFLOW XML:
 *   - ScriptRunner Groovy post-functions
 *     (com.onresolve.jira.groovy.GroovyFunctionPlugin)
 *   - ScriptRunner Groovy validators
 *     (com.onresolve.jira.groovy.GroovyValidator)
 *   - ScriptRunner Groovy conditions
 *     (com.onresolve.jira.groovy.GroovyCondition)
 *   - Power Scripts / SIL post-functions
 *     (com.keplerrominfo.jira.plugins.powerscripts.workflow.*)
 *   - Generic inline scripts in <arg name="script"> or <arg name="groovy.script">
 *
 * XML STRUCTURE (Jira workflow export format):
 *   <workflow name="My Workflow">
 *     <common-actions> / <actions>
 *       <action id="11" name="Approve">
 *         <results>
 *           <unconditional-result old-status="Open" status="Approved" ...>
 *             <post-functions>
 *               <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
 *                 <arg name="FIELD_FUNCTION_ID">uuid</arg>
 *                 <arg name="script">// Groovy code here</arg>
 *               </function>
 *             </post-functions>
 *             <validators> ... </validators>
 *             <conditions> ... </conditions>
 *           </unconditional-result>
 *         </results>
 *       </action>
 *     </actions>
 *   </workflow>
 *
 * SECURITY:
 *   - Script content is never executed — only extracted as a string
 *   - XML parsing is done with Node.js built-in DOMParser equivalent (regex-based
 *     extraction) to avoid external dependencies and XML injection risks
 *   - All extracted content is treated as untrusted and passed through the normal
 *     AtlasReforge parser pipeline (which has its own injection guards)
 */

import type {
  AtlassianModuleType,
  WorkflowContext,
} from '../types/parsed-script.types.js';

// ─── Output type ──────────────────────────────────────────────────────────────

export interface ExtractedWorkflowScript {
  /** The extracted script content */
  readonly scriptContent: string;

  /** Detected script language */
  readonly language: 'groovy' | 'sil' | 'unknown';

  /** Module type inferred from the XML function type */
  readonly moduleType: AtlassianModuleType;

  /** Full workflow context for this script */
  readonly workflowContext: WorkflowContext;

  /**
   * A suggested filename for this script (used as originalFilename in ParsedScript).
   * Format: {workflow}-{transition}-{type}-{index}.groovy
   */
  readonly suggestedFilename: string;
}

export interface WorkflowXmlParseResult {
  readonly workflowName: string;
  readonly scripts: ReadonlyArray<ExtractedWorkflowScript>;
  readonly parseWarnings: ReadonlyArray<string>;
}

// ─── Known ScriptRunner/Power Scripts function type → module type mapping ─────

interface FunctionTypeMapping {
  readonly moduleType: AtlassianModuleType;
  readonly language: 'groovy' | 'sil';
  readonly scriptArgNames: ReadonlyArray<string>; // XML <arg name="..."> that holds the script
}

const FUNCTION_TYPE_MAP: Record<string, FunctionTypeMapping> = {
  // ── ScriptRunner Groovy ───────────────────────────────────────────────────
  'com.onresolve.jira.groovy.GroovyFunctionPlugin': {
    moduleType: 'post-function',
    language: 'groovy',
    scriptArgNames: ['script', 'FIELD_FUNCTION_SCRIPT', 'groovy.script'],
  },
  'com.onresolve.jira.groovy.GroovyValidator': {
    moduleType: 'validator',
    language: 'groovy',
    scriptArgNames: ['script', 'groovy.script'],
  },
  'com.onresolve.jira.groovy.GroovyCondition': {
    moduleType: 'condition',
    language: 'groovy',
    scriptArgNames: ['script', 'groovy.script'],
  },
  // ScriptRunner inline script (older versions)
  'com.onresolve.scriptrunner.jira.workflow.postfunction.InlineScriptFunction': {
    moduleType: 'post-function',
    language: 'groovy',
    scriptArgNames: ['script', 'inline.script'],
  },
  'com.onresolve.scriptrunner.jira.workflow.validator.InlineScriptValidator': {
    moduleType: 'validator',
    language: 'groovy',
    scriptArgNames: ['script'],
  },
  'com.onresolve.scriptrunner.jira.workflow.condition.InlineScriptCondition': {
    moduleType: 'condition',
    language: 'groovy',
    scriptArgNames: ['script'],
  },

  // ── Power Scripts / SIL (cPrime/Appfire) ────────────────────────────────
  'com.keplerrominfo.jira.plugins.powerscripts.workflow.postfunction.SILPostFunction': {
    moduleType: 'post-function',
    language: 'sil',
    scriptArgNames: ['script', 'sil.script'],
  },
  'com.keplerrominfo.jira.plugins.powerscripts.workflow.validator.SILValidator': {
    moduleType: 'validator',
    language: 'sil',
    scriptArgNames: ['script', 'sil.script'],
  },
  'com.keplerrominfo.jira.plugins.powerscripts.workflow.condition.SILCondition': {
    moduleType: 'condition',
    language: 'sil',
    scriptArgNames: ['script', 'sil.script'],
  },
  // Appfire variant (renamed product)
  'com.appfire.jira.plugins.powerscripts.workflow.postfunction.SILPostFunction': {
    moduleType: 'post-function',
    language: 'sil',
    scriptArgNames: ['script'],
  },
  'com.appfire.jira.plugins.powerscripts.workflow.validator.SILValidator': {
    moduleType: 'validator',
    language: 'sil',
    scriptArgNames: ['script'],
  },
  'com.appfire.jira.plugins.powerscripts.workflow.condition.SILCondition': {
    moduleType: 'condition',
    language: 'sil',
    scriptArgNames: ['script'],
  },
};

// ─── XML extraction helpers ───────────────────────────────────────────────────

/**
 * Extracts the value of an attribute from an XML tag string.
 * e.g. extractAttr('<action id="11" name="Approve">', 'name') → 'Approve'
 */
function extractAttr(tag: string, attr: string): string | null {
  const pattern = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = tag.match(pattern);
  return m?.[1] ?? null;
}

/**
 * Extracts the text content of a specific <arg name="X"> element.
 * Handles CDATA sections and raw text.
 */
function extractArgValue(xml: string, argName: string): string | null {
  // Match <arg name="argName">content</arg> with optional CDATA
  const patterns = [
    // CDATA variant: <arg name="script"><![CDATA[...]]></arg>
    new RegExp(`<arg\\s+name="${escapeRegex(argName)}"[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/arg>`, 'i'),
    // Plain text variant: <arg name="script">...</arg>
    new RegExp(`<arg\\s+name="${escapeRegex(argName)}"[^>]*>([\\s\\S]*?)<\\/arg>`, 'i'),
  ];

  for (const pattern of patterns) {
    const m = xml.match(pattern);
    if (m?.[1] !== undefined) {
      return decodeXmlEntities(m[1].trim());
    }
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)));
}

/**
 * Extracts all <function type="X">...</function> blocks from a parent XML string.
 */
function extractFunctionBlocks(xml: string): Array<{ type: string; inner: string }> {
  const results: Array<{ type: string; inner: string }> = [];
  // Match opening <function type="..."> tags and their content
  const funcPattern = /<function\s+type="([^"]+)"[^>]*>([\s\S]*?)<\/function>/gi;
  let m: RegExpExecArray | null;
  while ((m = funcPattern.exec(xml)) !== null) {
    results.push({ type: m[1] ?? '', inner: m[2] ?? '' });
  }
  return results;
}

/**
 * Extracts all <action> blocks from the workflow XML.
 */
function extractActionBlocks(xml: string): Array<{
  id: string;
  name: string;
  inner: string;
}> {
  const results: Array<{ id: string; name: string; inner: string }> = [];
  const actionPattern = /<action\s([^>]+)>([\s\S]*?)<\/action>/gi;
  let m: RegExpExecArray | null;
  while ((m = actionPattern.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const id = extractAttr(attrs, 'id') ?? '?';
    const name = extractAttr(attrs, 'name') ?? `Action-${id}`;
    results.push({ id, name, inner });
  }
  return results;
}

/**
 * Extracts from/to status from the result element inside an action.
 * Looks for <unconditional-result old-status="X" status="Y" ...>
 */
function extractTransitionStatuses(actionXml: string): {
  fromStatus: string | null;
  toStatus: string | null;
} {
  // Try unconditional-result first (most common)
  const unconditionalMatch = actionXml.match(
    /<unconditional-result\s([^>]+)>/i,
  );
  if (unconditionalMatch) {
    const attrs = unconditionalMatch[1] ?? '';
    return {
      fromStatus: extractAttr(attrs, 'old-status'),
      toStatus: extractAttr(attrs, 'status'),
    };
  }

  // Try result (older format)
  const resultMatch = actionXml.match(/<result\s([^>]+)>/i);
  if (resultMatch) {
    const attrs = resultMatch[1] ?? '';
    return {
      fromStatus: extractAttr(attrs, 'old-status'),
      toStatus: extractAttr(attrs, 'status'),
    };
  }

  return { fromStatus: null, toStatus: null };
}

/**
 * Determines the module type from the XML context (post-functions, validators, conditions section).
 */
function inferModuleTypeFromContext(
  functionXml: string,
  parentXml: string,
): AtlassianModuleType {
  // Check if the function appears inside a <validators> block
  const validatorsBlock = parentXml.match(/<validators>([\s\S]*?)<\/validators>/i);
  if (validatorsBlock && validatorsBlock[1]?.includes(functionXml.slice(0, 50))) {
    return 'validator';
  }

  // Check if inside <conditions> block
  const conditionsBlock = parentXml.match(/<conditions>([\s\S]*?)<\/conditions>/i);
  if (conditionsBlock && conditionsBlock[1]?.includes(functionXml.slice(0, 50))) {
    return 'condition';
  }

  // Default: post-function
  return 'post-function';
}

// ─── Sanitize filename ────────────────────────────────────────────────────────

function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses a Jira workflow XML export and extracts all embedded scripts.
 *
 * @param xmlContent - Raw content of the .xml workflow export file
 * @returns Parsed result with all extracted scripts and their context
 */
export function parseWorkflowXml(xmlContent: string): WorkflowXmlParseResult {
  const warnings: string[] = [];

  // ── Extract workflow name ────────────────────────────────────────────────
  const workflowNameMatch = xmlContent.match(/<workflow\s+name="([^"]+)"/i);
  const workflowName = workflowNameMatch?.[1] ?? 'Unknown Workflow';

  // ── Extract all actions (transitions) ────────────────────────────────────
  const actions = extractActionBlocks(xmlContent);

  if (actions.length === 0) {
    warnings.push(
      'No <action> elements found in the XML. ' +
      'This may not be a valid Jira workflow export. ' +
      'Expected format: Jira Project Settings → Workflows → Export.',
    );
  }

  const allScripts: ExtractedWorkflowScript[] = [];
  let globalScriptIndex = 0;

  for (const action of actions) {
    const { fromStatus, toStatus } = extractTransitionStatuses(action.inner);
    const functions = extractFunctionBlocks(action.inner);

    let scriptIndexInTransition = 0;

    for (const func of functions) {
      const mapping = FUNCTION_TYPE_MAP[func.type];

      if (mapping === undefined) {
        // Unknown function type — skip but warn if it looks script-related
        if (
          func.type.toLowerCase().includes('groovy') ||
          func.type.toLowerCase().includes('script') ||
          func.type.toLowerCase().includes('sil')
        ) {
          warnings.push(
            `Unknown script function type: "${func.type}" in transition "${action.name}". ` +
            'Add this type to FUNCTION_TYPE_MAP in workflow-xml.parser.ts.',
          );
        }
        continue;
      }

      // Try each known arg name to find the script content
      let scriptContent: string | null = null;
      for (const argName of mapping.scriptArgNames) {
        scriptContent = extractArgValue(func.inner, argName);
        if (scriptContent !== null && scriptContent.trim().length > 0) break;
      }

      if (scriptContent === null || scriptContent.trim().length === 0) {
        // Function exists but has no inline script — likely uses a script file reference
        const fileRefArg = extractArgValue(func.inner, 'FIELD_FUNCTION_ID') ??
                           extractArgValue(func.inner, 'script.file');
        if (fileRefArg !== null) {
          warnings.push(
            `Transition "${action.name}": function "${func.type}" references an external script ` +
            `file/ID (${fileRefArg}). External file references cannot be extracted from the XML. ` +
            'Upload the script file separately.',
          );
        }
        continue;
      }

      const workflowContext: WorkflowContext = {
        workflowName,
        transitionName: action.name,
        fromStatus,
        toStatus,
        scriptIndex: scriptIndexInTransition,
        totalScriptsInWorkflow: 0, // patched below after counting all scripts
      };

      const ext = mapping.language === 'sil' ? 'sil' : 'groovy';
      const wfSlug = sanitizeFilename(workflowName);
      const txSlug = sanitizeFilename(action.name);
      const typeSlug = mapping.moduleType;
      const suggestedFilename = `${wfSlug}-${txSlug}-${typeSlug}-${scriptIndexInTransition}.${ext}`;

      allScripts.push({
        scriptContent,
        language: mapping.language,
        moduleType: mapping.moduleType,
        workflowContext,
        suggestedFilename,
      });

      scriptIndexInTransition++;
      globalScriptIndex++;
    }
  }

  // ── Patch totalScriptsInWorkflow now that we know the count ──────────────
  const total = allScripts.length;
  const patchedScripts: ExtractedWorkflowScript[] = allScripts.map((s) => ({
    ...s,
    workflowContext: { ...s.workflowContext, totalScriptsInWorkflow: total },
  }));

  if (total === 0 && warnings.length === 0) {
    warnings.push(
      'No script-bearing functions found in this workflow XML. ' +
      'The workflow may not contain ScriptRunner or Power Scripts functions, ' +
      'or the scripts may use external file references.',
    );
  }

  return {
    workflowName,
    scripts: patchedScripts,
    parseWarnings: warnings,
  };
}

/**
 * Returns true if the content looks like a Jira workflow XML export.
 * Used to decide whether to route the file through the workflow XML parser.
 */
export function isWorkflowXml(content: string): boolean {
  return (
    content.includes('<workflow') &&
    (content.includes('<action') || content.includes('<common-actions')) &&
    (
      content.includes('com.onresolve.jira') ||
      content.includes('com.keplerrominfo') ||
      content.includes('com.appfire.jira') ||
      content.includes('GroovyFunctionPlugin') ||
      content.includes('SILPostFunction') ||
      content.includes('<post-functions>') ||
      content.includes('<validators>') ||
      content.includes('<function type=')
    )
  );
}
