/**
 * @atlasreforge/parser — Workflow XML Parser Tests
 *
 * Tests for parseWorkflowXml() and isWorkflowXml():
 *   1. isWorkflowXml detection — true/false cases
 *   2. ScriptRunner Groovy post-function extraction
 *   3. ScriptRunner Groovy validator extraction
 *   4. Power Scripts SIL post-function extraction
 *   5. Multi-script transition (multiple post-functions on same action)
 *   6. Multi-transition workflow (N actions → N scripts)
 *   7. External file reference warning (no inline script)
 *   8. Unknown function type warning
 *   9. Empty workflow (no functions)
 *  10. CDATA-wrapped script content
 *  11. workflowContext fields (workflowName, transitionName, fromStatus, toStatus)
 *  12. totalScriptsInWorkflow count across all scripts
 */

import { describe, expect, it } from 'vitest';
import {
  isWorkflowXml,
  parseWorkflowXml,
} from '../src/parsers/workflow-xml.parser.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SR_POSTFUNCTION_SCRIPT = `
import com.atlassian.jira.component.ComponentAccessor
def issueManager = ComponentAccessor.getIssueManager()
def cf = ComponentAccessor.getCustomFieldManager().getCustomFieldObject("customfield_10048")
def budget = issue.getCustomFieldValue(cf)
if (budget > 50000) {
  issue.setAssignee(ComponentAccessor.getUserManager().getUserByName("finance.lead"))
}
issue.store()
`.trim();

const SR_VALIDATOR_SCRIPT = `
import com.atlassian.jira.component.ComponentAccessor
def cf = ComponentAccessor.getCustomFieldManager().getCustomFieldObject("customfield_10052")
def value = issue.getCustomFieldValue(cf)
if (value == null || value.toString().trim().isEmpty()) {
  invalidInputException.addError("customfield_10052", "Budget is required for approval")
  return false
}
`.trim();

const SIL_POSTFUNCTION_SCRIPT = `
// Power Scripts SIL Post-function
number budget = getFieldValue("customfield_10048");
string lead = "finance.lead@company.com";
if (budget > 50000) {
  setFieldValue("Assignee", lead);
  addComment(issue, "Auto-assigned to finance team");
}
`.trim();

function buildSingleActionXml(opts: {
  workflowName?: string;
  actionName?: string;
  actionId?: string;
  fromStatus?: string;
  toStatus?: string;
  functionType?: string;
  scriptContent?: string;
  section?: 'post-functions' | 'validators' | 'conditions';
  useCdata?: boolean;
}): string {
  const {
    workflowName = 'Test Workflow',
    actionName = 'Approve',
    actionId = '11',
    fromStatus = 'In Review',
    toStatus = 'Approved',
    functionType = 'com.onresolve.jira.groovy.GroovyFunctionPlugin',
    scriptContent = SR_POSTFUNCTION_SCRIPT,
    section = 'post-functions',
    useCdata = false,
  } = opts;

  const scriptArg = useCdata
    ? `<arg name="script"><![CDATA[${scriptContent}]]></arg>`
    : `<arg name="script">${scriptContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</arg>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<workflow name="${workflowName}">
  <meta name="jira.description">Test workflow</meta>
  <initial-actions>
    <action id="1" name="Create">
      <results>
        <unconditional-result old-status="None" status="Open" />
      </results>
    </action>
  </initial-actions>
  <actions>
    <action id="${actionId}" name="${actionName}">
      <results>
        <unconditional-result old-status="${fromStatus}" status="${toStatus}">
          <${section}>
            <function type="${functionType}">
              <arg name="FIELD_FUNCTION_ID">test-uuid-123</arg>
              ${scriptArg}
            </function>
          </${section}>
        </unconditional-result>
      </results>
    </action>
  </actions>
</workflow>`;
}

// ─── isWorkflowXml tests ──────────────────────────────────────────────────────

describe('isWorkflowXml', () => {
  it('returns true for a valid ScriptRunner workflow XML', () => {
    const xml = buildSingleActionXml({});
    expect(isWorkflowXml(xml)).toBe(true);
  });

  it('returns true when GroovyFunctionPlugin is present', () => {
    const xml = buildSingleActionXml({ functionType: 'com.onresolve.jira.groovy.GroovyFunctionPlugin' });
    expect(isWorkflowXml(xml)).toBe(true);
  });

  it('returns true for Power Scripts SIL workflow XML', () => {
    const xml = buildSingleActionXml({
      functionType: 'com.keplerrominfo.jira.plugins.powerscripts.workflow.postfunction.SILPostFunction',
    });
    expect(isWorkflowXml(xml)).toBe(true);
  });

  it('returns false for a plain Groovy script file', () => {
    expect(isWorkflowXml(SR_POSTFUNCTION_SCRIPT)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isWorkflowXml('')).toBe(false);
  });

  it('returns false for a generic XML without workflow content', () => {
    const xml = '<?xml version="1.0"?><config><setting>value</setting></config>';
    expect(isWorkflowXml(xml)).toBe(false);
  });
});

// ─── parseWorkflowXml — basic extraction ─────────────────────────────────────

describe('parseWorkflowXml — script extraction', () => {
  it('extracts a ScriptRunner Groovy post-function', () => {
    const xml = buildSingleActionXml({ scriptContent: SR_POSTFUNCTION_SCRIPT });
    const result = parseWorkflowXml(xml);

    expect(result.scripts).toHaveLength(1);
    const script = result.scripts[0]!;
    expect(script.language).toBe('groovy');
    expect(script.moduleType).toBe('post-function');
    expect(script.scriptContent).toContain('ComponentAccessor');
    expect(script.scriptContent).toContain('customfield_10048');
  });

  it('extracts a ScriptRunner Groovy validator', () => {
    const xml = buildSingleActionXml({
      functionType: 'com.onresolve.jira.groovy.GroovyValidator',
      scriptContent: SR_VALIDATOR_SCRIPT,
      section: 'validators',
    });
    const result = parseWorkflowXml(xml);

    expect(result.scripts).toHaveLength(1);
    const script = result.scripts[0]!;
    expect(script.language).toBe('groovy');
    expect(script.moduleType).toBe('validator');
    expect(script.scriptContent).toContain('invalidInputException');
  });

  it('extracts a Power Scripts SIL post-function', () => {
    const xml = buildSingleActionXml({
      functionType: 'com.keplerrominfo.jira.plugins.powerscripts.workflow.postfunction.SILPostFunction',
      scriptContent: SIL_POSTFUNCTION_SCRIPT,
    });
    const result = parseWorkflowXml(xml);

    expect(result.scripts).toHaveLength(1);
    const script = result.scripts[0]!;
    expect(script.language).toBe('sil');
    expect(script.moduleType).toBe('post-function');
    expect(script.scriptContent).toContain('getFieldValue');
  });

  it('extracts scripts from CDATA-wrapped content', () => {
    const xml = buildSingleActionXml({
      scriptContent: SR_POSTFUNCTION_SCRIPT,
      useCdata: true,
    });
    const result = parseWorkflowXml(xml);

    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]!.scriptContent).toContain('ComponentAccessor');
  });
});

// ─── parseWorkflowXml — workflow context ─────────────────────────────────────

describe('parseWorkflowXml — WorkflowContext', () => {
  it('populates workflowName correctly', () => {
    const xml = buildSingleActionXml({ workflowName: 'Software Development Workflow' });
    const result = parseWorkflowXml(xml);

    expect(result.workflowName).toBe('Software Development Workflow');
    expect(result.scripts[0]!.workflowContext.workflowName).toBe('Software Development Workflow');
  });

  it('populates transitionName correctly', () => {
    const xml = buildSingleActionXml({ actionName: 'Start Code Review' });
    const result = parseWorkflowXml(xml);

    expect(result.scripts[0]!.workflowContext.transitionName).toBe('Start Code Review');
  });

  it('populates fromStatus and toStatus from unconditional-result', () => {
    const xml = buildSingleActionXml({
      fromStatus: 'In Progress',
      toStatus: 'Code Review',
    });
    const result = parseWorkflowXml(xml);

    const ctx = result.scripts[0]!.workflowContext;
    expect(ctx.fromStatus).toBe('In Progress');
    expect(ctx.toStatus).toBe('Code Review');
  });

  it('patches totalScriptsInWorkflow correctly', () => {
    const xml = buildSingleActionXml({});
    const result = parseWorkflowXml(xml);

    expect(result.scripts[0]!.workflowContext.totalScriptsInWorkflow).toBe(1);
  });

  it('generates a suggestedFilename with workflow + transition slug', () => {
    const xml = buildSingleActionXml({
      workflowName: 'Bug Fix Workflow',
      actionName: 'Approve Fix',
    });
    const result = parseWorkflowXml(xml);

    const filename = result.scripts[0]!.suggestedFilename;
    expect(filename).toContain('bug-fix-workflow');
    expect(filename).toContain('approve-fix');
    expect(filename).toMatch(/\.(groovy|sil)$/);
  });
});

// ─── parseWorkflowXml — multi-script scenarios ────────────────────────────────

describe('parseWorkflowXml — multi-script scenarios', () => {
  it('extracts multiple scripts from a multi-action workflow', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workflow name="Multi-Action Workflow">
  <actions>
    <action id="11" name="Approve">
      <results>
        <unconditional-result old-status="Open" status="Approved">
          <post-functions>
            <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
              <arg name="script">def x = 1; // approve script</arg>
            </function>
          </post-functions>
        </unconditional-result>
      </results>
    </action>
    <action id="12" name="Reject">
      <results>
        <unconditional-result old-status="Open" status="Rejected">
          <post-functions>
            <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
              <arg name="script">def x = 2; // reject script</arg>
            </function>
          </post-functions>
        </unconditional-result>
      </results>
    </action>
  </actions>
</workflow>`;

    const result = parseWorkflowXml(xml);
    expect(result.scripts).toHaveLength(2);

    // totalScriptsInWorkflow should be 2 on both
    expect(result.scripts[0]!.workflowContext.totalScriptsInWorkflow).toBe(2);
    expect(result.scripts[1]!.workflowContext.totalScriptsInWorkflow).toBe(2);

    // Transition names
    const transitions = result.scripts.map(s => s.workflowContext.transitionName);
    expect(transitions).toContain('Approve');
    expect(transitions).toContain('Reject');
  });

  it('sets scriptIndex correctly for multiple scripts in same transition', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workflow name="Multi-PF Workflow">
  <actions>
    <action id="11" name="Approve">
      <results>
        <unconditional-result old-status="Open" status="Approved">
          <post-functions>
            <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
              <arg name="script">// script 0</arg>
            </function>
            <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
              <arg name="script">// script 1</arg>
            </function>
          </post-functions>
        </unconditional-result>
      </results>
    </action>
  </actions>
</workflow>`;

    const result = parseWorkflowXml(xml);
    expect(result.scripts).toHaveLength(2);
    expect(result.scripts[0]!.workflowContext.scriptIndex).toBe(0);
    expect(result.scripts[1]!.workflowContext.scriptIndex).toBe(1);
  });
});

// ─── parseWorkflowXml — warnings ─────────────────────────────────────────────

describe('parseWorkflowXml — warnings', () => {
  it('warns on unknown script-related function type', () => {
    const xml = buildSingleActionXml({
      functionType: 'com.somevendor.jira.groovy.CustomGroovyFunction',
      scriptContent: 'def x = 1',
    });
    const result = parseWorkflowXml(xml);

    expect(result.parseWarnings.length).toBeGreaterThan(0);
    expect(result.parseWarnings[0]).toContain('Unknown script function type');
  });

  it('warns when function has no inline script content', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workflow name="External Script Workflow">
  <actions>
    <action id="11" name="Approve">
      <results>
        <unconditional-result old-status="Open" status="Approved">
          <post-functions>
            <function type="com.onresolve.jira.groovy.GroovyFunctionPlugin">
              <arg name="FIELD_FUNCTION_ID">some-external-script-uuid</arg>
            </function>
          </post-functions>
        </unconditional-result>
      </results>
    </action>
  </actions>
</workflow>`;

    const result = parseWorkflowXml(xml);
    expect(result.scripts).toHaveLength(0);
    expect(result.parseWarnings.some(w => w.includes('external script'))).toBe(true);
  });

  it('warns when no scripts are found at all', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workflow name="Empty Workflow">
  <actions>
    <action id="11" name="Start">
      <results>
        <unconditional-result old-status="None" status="Open" />
      </results>
    </action>
  </actions>
</workflow>`;

    const result = parseWorkflowXml(xml);
    expect(result.scripts).toHaveLength(0);
    expect(result.parseWarnings.length).toBeGreaterThan(0);
  });
});
