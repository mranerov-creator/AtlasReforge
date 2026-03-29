/**
 * WorkspacePage
 *
 * The main migration workspace. Layout:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Header: filename | readiness badge | tabs          │
 *   ├─────────────────┬───────────────────────────────────┤
 *   │  Left sidebar   │  Main content                     │
 *   │  (Registry)     │  [Summary | Forge | SR | Diagram] │
 *   │                 │                                   │
 *   │  Progress       │  SplitEditor or MermaidDiagram    │
 *   │  Blockers       │                                   │
 *   └─────────────────┴───────────────────────────────────┘
 */

import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useJobPolling } from '../hooks/useJobPolling.js';
import { useRegistry } from '../hooks/useRegistry.js';
import { ReadinessBadge } from '../components/triage/ReadinessBadge.jsx';
import { ProgressPipeline } from '../components/triage/ProgressPipeline.jsx';
import { SplitEditor } from '../components/editor/SplitEditor.jsx';
import { MermaidDiagram } from '../components/diagram/MermaidDiagram.jsx';
import { RegistryPanel } from '../components/registry/RegistryPanel.jsx';
import type { ActiveTab, AutomationRule } from '../types/index.js';
import { importAutomationRule, ApiError } from '../lib/api-client.js';

// ─── ROI Bar ──────────────────────────────────────────────────────────────────

function RoiBar({ consultantHours, aiHours, savingsPercent }: {
  consultantHours: number;
  aiHours: number;
  savingsPercent: number;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: '24px', padding: '10px 16px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #86efac', flexWrap: 'wrap' }}>
      <div style={{ fontSize: '13px' }}>
        <span style={{ color: '#6b7280' }}>Manual effort: </span>
        <strong style={{ color: '#374151' }}>{consultantHours}h</strong>
      </div>
      <div style={{ fontSize: '13px' }}>
        <span style={{ color: '#6b7280' }}>AI-assisted: </span>
        <strong style={{ color: '#15803d' }}>{aiHours}h</strong>
      </div>
      <div style={{ fontSize: '13px' }}>
        <span style={{ color: '#6b7280' }}>Time saved: </span>
        <strong style={{ color: '#15803d' }}>🚀 {savingsPercent}%</strong>
      </div>
    </div>
  );
}

// ─── Pipeline progress animation ─────────────────────────────────────────────

const PIPELINE_STAGES = [
  { key: 'queued',       label: 'Queued',       icon: '📋' },
  { key: 'parsing',      label: 'Parsing',      icon: '🔍' },
  { key: 'classifying',  label: 'Classifying',  icon: '🧠' },
  { key: 'extracting',   label: 'Extracting',   icon: '⚙️' },
  { key: 'retrieving',   label: 'Retrieving',   icon: '📚' },
  { key: 'generating',   label: 'Generating',   icon: '✨' },
  { key: 'validating',   label: 'Validating',   icon: '🛡️' },
  { key: 'resolving',    label: 'Resolving',    icon: '🔗' },
  { key: 'completed',    label: 'Completed',    icon: '✅' },
] as const;

const FUN_FACTS = [
  '💡 Forge apps use an invocation-based model — no persistent server needed.',
  '🔒 Cloud REST API v3 uses accountId instead of usernames (GDPR compliance).',
  '⚡ @forge/api requestJira() handles OAuth automatically — no manual token management.',
  '📊 Each migration generates a Mermaid sequence diagram of the new async flow.',
  '🔄 Server post-functions are synchronous, but Forge post-functions are async.',
  '🏗️ The S4 generator produces a complete Forge app scaffold: manifest + handlers.',
  '🎯 Custom field IDs may differ between Server/DC and Cloud instances.',
  '📝 Generated code includes ATLAS_*() placeholders for field mapping resolution.',
];

function PipelineProgress({ currentStage, progress }: { currentStage: string; progress: number }): React.ReactElement {
  const [elapsed, setElapsed] = React.useState(0);
  const [factIndex, setFactIndex] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const factTimer = setInterval(() => setFactIndex((i) => (i + 1) % FUN_FACTS.length), 6000);
    return () => clearInterval(factTimer);
  }, []);

  const currentIdx = PIPELINE_STAGES.findIndex((s) => s.key === currentStage);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '24px', padding: '40px' }}>
      {/* Animated spinner */}
      <div style={{ position: 'relative', width: '80px', height: '80px' }}>
        <div style={{
          width: '80px', height: '80px', borderRadius: '50%',
          border: '4px solid #e5e7eb', borderTopColor: '#6366f1',
          animation: 'atlasReforgeSpinner 1s linear infinite',
        }} />
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' }}>
          {PIPELINE_STAGES[currentIdx >= 0 ? currentIdx : 0]?.icon ?? '⚡'}
        </span>
      </div>

      {/* Title */}
      <div style={{ textAlign: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#111827' }}>
          Migrating your script to Cloud
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#6b7280' }}>
          {minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`} elapsed
        </p>
      </div>

      {/* Progress bar */}
      <div style={{ width: '100%', maxWidth: '480px' }}>
        <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '9999px', overflow: 'hidden' }}>
          <div style={{
            width: `${progress}%`, height: '100%', borderRadius: '9999px',
            background: 'linear-gradient(90deg, #818cf8, #6366f1, #4f46e5)',
            transition: 'width 0.6s ease-out',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#9ca3af' }}>
          <span>{progress}%</span>
          <span style={{ fontWeight: 500, color: '#6366f1' }}>
            {currentStage === 'starting' ? 'Initializing...' : currentStage.charAt(0).toUpperCase() + currentStage.slice(1)}
          </span>
        </div>
      </div>

      {/* Stage pipeline */}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        {PIPELINE_STAGES.filter(s => s.key !== 'queued' && s.key !== 'completed').map((stage, idx) => {
          const stageIdx = PIPELINE_STAGES.findIndex(s => s.key === stage.key);
          const isDone = currentIdx > stageIdx;
          const isCurrent = currentIdx === stageIdx;
          return (
            <React.Fragment key={stage.key}>
              {idx > 0 && <div style={{ width: '16px', height: '2px', background: isDone ? '#6366f1' : '#e5e7eb', transition: 'background 0.4s' }} />}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 500,
                transition: 'all 0.4s',
                background: isCurrent ? '#eef2ff' : isDone ? '#f0fdf4' : '#f9fafb',
                color: isCurrent ? '#4f46e5' : isDone ? '#15803d' : '#9ca3af',
                border: isCurrent ? '1.5px solid #6366f1' : '1px solid transparent',
                transform: isCurrent ? 'scale(1.05)' : 'scale(1)',
              }}>
                {isDone ? <span>✓</span> : isCurrent ? <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#6366f1', animation: 'atlasReforgePulse 1.2s ease-in-out infinite' }} /> : null}
                <span>{stage.label}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Fun fact */}
      <div style={{
        maxWidth: '420px', padding: '12px 16px', borderRadius: '8px',
        background: '#fffbeb', border: '1px solid #fde68a',
        fontSize: '13px', color: '#92400e', textAlign: 'center',
        animation: 'atlasReforgeFadeIn 0.5s ease-in',
      }} key={factIndex}>
        {FUN_FACTS[factIndex]}
      </div>

      {/* CSS animations */}
      <style>{`
        @keyframes atlasReforgeSpinner {
          to { transform: rotate(360deg); }
        }
        @keyframes atlasReforgePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }
        @keyframes atlasReforgeFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Confidence row ───────────────────────────────────────────────────────────

function ConfidenceRow({ label, score, note, requiresHumanReview }: {
  label: string;
  score: number;
  note: string;
  requiresHumanReview: boolean;
}): React.ReactElement {
  const pct = Math.round(score * 100);
  const color = score >= 0.8 ? '#22c55e' : score >= 0.6 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
      <span style={{ fontSize: '12px', color: '#6b7280', width: '130px', flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: '6px', background: '#e5e7eb', borderRadius: '9999px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '9999px', transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontSize: '12px', fontWeight: 600, color, width: '36px', textAlign: 'right' }}>{pct}%</span>
      {requiresHumanReview && (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', cursor: 'help' }} className="atlas-tooltip-trigger">
          <span style={{ fontSize: '13px' }}>👁</span>
          <div className="atlas-tooltip" style={{
            position: 'absolute', right: '100%', marginRight: '8px', zIndex: 50,
            background: '#1f2937', color: '#fff', padding: '6px 10px',
            borderRadius: '6px', fontSize: '12px', width: 'max-content', maxWidth: '250px',
            boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
            pointerEvents: 'none',
          }}>
            {note}
            {/* Tooltip arrow */}
            <div style={{
              position: 'absolute', top: '50%', right: '-4px', transform: 'translateY(-50%)',
              borderStyle: 'solid', borderWidth: '5px 0 5px 5px',
              borderColor: 'transparent transparent transparent #1f2937',
            }} />
          </div>
        </div>
      )}
      <style>{`
        .atlas-tooltip { opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0.2s; }
        .atlas-tooltip-trigger:hover .atlas-tooltip { opacity: 1; visibility: visible; }
      `}</style>
    </div>
  );
}

// ─── Summary tab ─────────────────────────────────────────────────────────────

function SummaryTab({ result }: { result: NonNullable<ReturnType<typeof useJobPolling>['result']> }): React.ReactElement {
  // Safe defaults for fields that may be null when S4 fails
  const businessLogic = result.businessLogic ?? {
    triggerDescription: 'Analysis not available',
    purposeNarrative: 'The code generator did not produce a business logic summary.',
    inputConditions: [] as string[],
    outputActions: [] as string[],
  };
  const confidence = result.confidence ?? null;
  const effort = result.estimatedEffortHours ?? { consultantHours: 0, aiAssistedHours: 0, savingsPercent: 0 };

  return (
    <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>

      {/* Workflow XML context banner — shown only when script came from a workflow XML */}
      {result.workflowContext !== null && result.workflowContext !== undefined && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '12px',
          padding: '12px 16px', marginBottom: '16px',
          background: 'linear-gradient(135deg, #f0f9ff 0%, #eff6ff 100%)',
          border: '1px solid #bae6fd', borderRadius: '10px',
        }}>
          <span style={{ fontSize: '20px', flexShrink: 0 }}>📋</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#0369a1', marginBottom: '4px' }}>
              Extracted from Jira Workflow XML
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '12px', color: '#374151' }}>
              <span>
                <span style={{ color: '#6b7280' }}>Workflow: </span>
                <strong>{result.workflowContext.workflowName}</strong>
              </span>
              <span style={{ color: '#d1d5db' }}>·</span>
              <span>
                <span style={{ color: '#6b7280' }}>Transition: </span>
                <strong>{result.workflowContext.transitionName}</strong>
              </span>
              {result.workflowContext.fromStatus !== null && (
                <>
                  <span style={{ color: '#d1d5db' }}>·</span>
                  <span>
                    <span style={{ color: '#6b7280' }}>Flow: </span>
                    <strong>{result.workflowContext.fromStatus}</strong>
                    <span style={{ color: '#6b7280' }}> → </span>
                    <strong>{result.workflowContext.toStatus ?? '?'}</strong>
                  </span>
                </>
              )}
              <span style={{ color: '#d1d5db' }}>·</span>
              <span style={{ color: '#6b7280' }}>
                Script {result.workflowContext.scriptIndex + 1} of {result.workflowContext.totalScriptsInWorkflow}
              </span>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
        <ReadinessBadge level={result.cloudReadinessLevel} score={result.cloudReadinessScore} size="lg" />
        <span style={{ fontSize: '13px', color: '#6b7280' }}>→ {result.recommendedTarget}</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>•</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{result.complexity} complexity</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>•</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{result.linesOfCode} LOC</span>
      </div>

      <RoiBar
        consultantHours={effort.consultantHours}
        aiHours={effort.aiAssistedHours}
        savingsPercent={effort.savingsPercent}
      />

      <div style={{ marginTop: '20px', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>Business Logic</h3>
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#374151', fontWeight: 500 }}>
            {businessLogic.triggerDescription}
          </p>
          <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#6b7280', lineHeight: 1.6 }}>
            {businessLogic.purposeNarrative}
          </p>
          {businessLogic.inputConditions.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ fontSize: '12px', color: '#374151' }}>Conditions:</strong>
              {businessLogic.inputConditions.map((c: string, i: number) => (
                <div key={i} style={{ fontSize: '12px', color: '#6b7280', marginLeft: '12px' }}>• {c}</div>
              ))}
            </div>
          )}
          {businessLogic.outputActions.length > 0 && (
            <div>
              <strong style={{ fontSize: '12px', color: '#374151' }}>Actions:</strong>
              {businessLogic.outputActions.map((a: string, i: number) => (
                <div key={i} style={{ fontSize: '12px', color: '#6b7280', marginLeft: '12px' }}>• {a}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      {confidence !== null && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>Confidence Scores</h3>
          <ConfidenceRow label="Field Mapping"   {...confidence.fieldMapping}   />
          <ConfidenceRow label="Webhook Logic"   {...confidence.webhookLogic}   />
          <ConfidenceRow label="User Resolution" {...confidence.userResolution} />
          <ConfidenceRow label="OAuth Scopes"    {...confidence.oauthScopes}    />
          <ConfidenceRow label="Overall"         {...confidence.overallMigration} />
        </div>
      )}

      {(result.oauthScopes?.length ?? 0) > 0 && (
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '8px' }}>OAuth Scopes Required</h3>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {result.oauthScopes.map(s => (
              <code key={s} style={{ fontSize: '11px', padding: '3px 8px', background: '#dbeafe', color: '#1d4ed8', borderRadius: '4px' }}>{s}</code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Automation tab ───────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  };
  return (
    <button onClick={handleCopy} style={{
      fontSize: '12px', padding: '4px 10px',
      border: '1px solid #d1d5db', borderRadius: '5px',
      background: copied ? '#f0fdf4' : '#fff',
      color: copied ? '#15803d' : '#374151',
      cursor: 'pointer', fontWeight: 500, transition: 'all 0.15s',
    }}>
      {copied ? '✓ Copied' : '📋 Copy'}
    </button>
  );
}

function AutomationTab({ rule }: { rule: AutomationRule }): React.ReactElement {
  const [jsonExpanded, setJsonExpanded] = React.useState(false);

  // Pretty-print the rule JSON
  let prettyJson = rule.ruleJson;
  try {
    prettyJson = JSON.stringify(JSON.parse(rule.ruleJson), null, 2);
  } catch { /* leave as-is if already malformed */ }

  return (
    <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
      {/* Header banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '14px 18px', marginBottom: '20px',
        background: 'linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%)',
        border: '1px solid #bfdbfe', borderRadius: '10px',
      }}>
        <span style={{ fontSize: '28px' }}>🔵</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px', color: '#1e40af' }}>
            Automation-Native Migration
          </div>
          <div style={{ fontSize: '12px', color: '#3b82f6', marginTop: '2px' }}>
            No code required — import directly via Jira Settings → Automation → Import rule
          </div>
        </div>
      </div>

      {/* Rule name */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
          Rule Name
        </div>
        <div style={{
          fontSize: '16px', fontWeight: 600, color: '#111827',
          padding: '10px 14px', background: '#f9fafb',
          border: '1px solid #e5e7eb', borderRadius: '8px',
        }}>
          {rule.ruleName}
        </div>
      </div>

      {/* Description */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
          What this rule does
        </div>
        <p style={{ fontSize: '14px', color: '#374151', lineHeight: 1.6, margin: 0 }}>
          {rule.description}
        </p>
      </div>

      {/* Rule JSON — importable */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Automation Rule JSON
            <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 400, color: '#3b82f6', background: '#dbeafe', padding: '2px 6px', borderRadius: '4px' }}>
              Import-ready
            </span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <CopyButton text={prettyJson} />
            <button
              onClick={() => { setJsonExpanded(!jsonExpanded); }}
              style={{
                fontSize: '12px', padding: '4px 10px',
                border: '1px solid #d1d5db', borderRadius: '5px',
                background: '#fff', color: '#374151',
                cursor: 'pointer',
              }}
            >
              {jsonExpanded ? '▲ Collapse' : '▼ Expand'}
            </button>
          </div>
        </div>
        <div style={{
          position: 'relative',
          background: '#0f172a', borderRadius: '8px',
          border: '1px solid #1e293b', overflow: 'hidden',
          maxHeight: jsonExpanded ? 'none' : '280px',
          transition: 'max-height 0.3s',
        }}>
          <pre style={{
            margin: 0, padding: '16px',
            fontSize: '12px', lineHeight: 1.6,
            color: '#e2e8f0', overflowX: 'auto',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}>
            {prettyJson}
          </pre>
          {!jsonExpanded && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: '60px',
              background: 'linear-gradient(transparent, #0f172a)',
            }} />
          )}
        </div>
      </div>

      {/* Direct API import */}
      <DirectImportForm ruleJson={rule.ruleJson} />

      {/* Manual import instructions — fallback */}
      <div style={{ marginBottom: '20px', padding: '14px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '8px' }}>
          📥 Or import manually
        </div>
        <ol style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: '#6b7280', lineHeight: 1.8 }}>
          <li>Go to <strong>Jira Settings → Automation</strong></li>
          <li>Click <strong>Import rules</strong> (top right)</li>
          <li>Paste the JSON above and click <strong>Import</strong></li>
          <li>Review and enable the rule</li>
        </ol>
      </div>

      {/* Post-import steps */}
      {rule.postImportSteps.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            ⚠️ Required post-import steps
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: '#374151', lineHeight: 1.8 }}>
            {rule.postImportSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Limitations */}
      {rule.limitations.length > 0 && (
        <div style={{ padding: '14px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#92400e', marginBottom: '8px' }}>
            ⚠️ Limitations vs original script
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: '#78350f', lineHeight: 1.8 }}>
            {rule.limitations.map((lim, i) => (
              <li key={i}>{lim}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}


// ─── Direct import form ───────────────────────────────────────────────────────

interface ImportState {
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
  ruleUrl: string | null;
}

function DirectImportForm({ ruleJson }: { ruleJson: string }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [apiToken, setApiToken] = React.useState('');
  const [jiraBaseUrl, setJiraBaseUrl] = React.useState('https://');
  const [importState, setImportState] = React.useState<ImportState>({
    status: 'idle', message: '', ruleUrl: null,
  });

  const handleImport = async () => {
    if (!email.trim() || !apiToken.trim() || !jiraBaseUrl.trim()) return;
    setImportState({ status: 'loading', message: 'Importing rule...', ruleUrl: null });
    try {
      const result = await importAutomationRule({ ruleJson, jiraBaseUrl, email, apiToken });
      setImportState({ status: 'success', message: result.message, ruleUrl: result.ruleUrl });
      // Clear credentials from state immediately after use
      setApiToken('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Unexpected error. Please try again.';
      setImportState({ status: 'error', message: msg, ruleUrl: null });
    }
  };

  return (
    <div style={{ marginBottom: '20px', border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden' }}>
      {/* Collapsible header */}
      <button
        onClick={() => { setExpanded(!expanded); }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: expanded ? '#f0f9ff' : '#f9fafb',
          border: 'none', cursor: 'pointer', borderBottom: expanded ? '1px solid #e5e7eb' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>🚀</span>
          <span style={{ fontWeight: 600, fontSize: '14px', color: '#1e40af' }}>
            Import directly via API
          </span>
          <span style={{
            fontSize: '11px', padding: '2px 7px', borderRadius: '10px',
            background: '#dbeafe', color: '#1d4ed8', fontWeight: 500,
          }}>
            One-click
          </span>
        </div>
        <span style={{ fontSize: '12px', color: '#6b7280' }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '16px', background: '#fff' }}>
          <p style={{ fontSize: '13px', color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
            Enter your Atlassian credentials to import this rule directly.
            Your API token is used only for this request and is never stored.
          </p>

          {/* Form fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
                Jira Cloud URL
              </label>
              <input
                type="url"
                value={jiraBaseUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setJiraBaseUrl(e.target.value); }}
                placeholder="https://yourcompany.atlassian.net"
                style={{
                  width: '100%', padding: '8px 10px', fontSize: '13px',
                  border: '1px solid #d1d5db', borderRadius: '6px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setEmail(e.target.value); }}
                placeholder="you@company.com"
                style={{
                  width: '100%', padding: '8px 10px', fontSize: '13px',
                  border: '1px solid #d1d5db', borderRadius: '6px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' }}>
                API Token
                <a
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ marginLeft: '6px', fontSize: '11px', color: '#3b82f6', fontWeight: 400 }}
                >
                  Generate token ↗
                </a>
              </label>
              <input
                type="password"
                value={apiToken}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setApiToken(e.target.value); }}
                placeholder="ATATT3x..."
                autoComplete="off"
                style={{
                  width: '100%', padding: '8px 10px', fontSize: '13px',
                  border: '1px solid #d1d5db', borderRadius: '6px',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />
              <p style={{ fontSize: '11px', color: '#9ca3af', margin: '4px 0 0' }}>
                🔒 Token is sent directly to your Jira instance and never stored by AtlasReforge
              </p>
            </div>
          </div>

          {/* Import button */}
          <button
            onClick={() => { void handleImport(); }}
            disabled={importState.status === 'loading' || !email || !apiToken || jiraBaseUrl === 'https://'}
            style={{
              width: '100%', padding: '10px', fontWeight: 600, fontSize: '14px',
              border: 'none', borderRadius: '7px', cursor: importState.status === 'loading' ? 'wait' : 'pointer',
              background: importState.status === 'loading' ? '#93c5fd' : '#2563eb',
              color: '#fff', transition: 'background 0.15s',
              opacity: (!email || !apiToken || jiraBaseUrl === 'https://') ? 0.5 : 1,
            }}
          >
            {importState.status === 'loading' ? '⟳ Importing...' : '🚀 Import rule to Jira Cloud'}
          </button>

          {/* Status feedback */}
          {importState.status === 'success' && (
            <div style={{
              marginTop: '12px', padding: '12px 14px',
              background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#15803d', marginBottom: '4px' }}>
                ✅ {importState.message}
              </div>
              {importState.ruleUrl !== null && (
                <a
                  href={importState.ruleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: '13px', color: '#2563eb', textDecoration: 'underline' }}
                >
                  Open rule in Jira Automation →
                </a>
              )}
              <p style={{ fontSize: '12px', color: '#6b7280', margin: '6px 0 0' }}>
                The rule is imported in <strong>disabled</strong> state. Review it and enable it when ready.
              </p>
            </div>
          )}

          {importState.status === 'error' && (
            <div style={{
              marginTop: '12px', padding: '12px 14px',
              background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#dc2626', marginBottom: '2px' }}>
                ❌ Import failed
              </div>
              <div style={{ fontSize: '13px', color: '#991b1b' }}>
                {importState.message}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Manual Rewrite tab ───────────────────────────────────────────────────────

function ManualRewriteTab({ result }: {
  result: NonNullable<ReturnType<typeof useJobPolling>['result']>
}): React.ReactElement {
  // Group issues by category to show actionable groups
  const validationIssues = result.validationIssues ?? [];
  const blockers = validationIssues.filter((i) => i.severity === 'error');

  return (
    <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '14px 18px', marginBottom: '20px',
        background: 'linear-gradient(135deg, #fef2f2 0%, #fff7ed 100%)',
        border: '1px solid #fca5a5', borderRadius: '10px',
      }}>
        <span style={{ fontSize: '28px' }}>🔴</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px', color: '#b91c1c' }}>
            Manual Rewrite Required
          </div>
          <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '2px' }}>
            This script uses patterns with no automated migration path in Atlassian Cloud.
          </div>
        </div>
      </div>

      {/* Why it can't be automated */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '10px' }}>
          Why automated migration is not possible
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {validationIssues.length === 0 ? (
            <div style={{ padding: '12px 14px', background: '#fef9c3', border: '1px solid #fde047',
              borderRadius: '8px', fontSize: '13px', color: '#92400e' }}>
              The analyzer detected hard blockers during parsing. Check the readiness report for details.
            </div>
          ) : (
            blockers.map((issue, i) => (
              <div key={i} style={{
                padding: '12px 14px', background: '#fee2e2',
                border: '1px solid #fca5a5', borderRadius: '8px',
              }}>
                <div style={{ fontWeight: 600, fontSize: '13px', color: '#b91c1c', marginBottom: '3px' }}>
                  ❌ {issue.code} — {issue.message}
                </div>
                <div style={{ fontSize: '12px', color: '#dc2626' }}>{issue.file}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recommended approach */}
      <div style={{ marginBottom: '20px', padding: '16px', background: '#f0f9ff',
        border: '1px solid #bae6fd', borderRadius: '8px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#0369a1', marginBottom: '10px' }}>
          💡 Recommended approach
        </h3>
        <ol style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: '#374151', lineHeight: 2 }}>
          <li>Review the <strong>Summary tab</strong> for a detailed breakdown of all issues</li>
          <li>Address each blocker listed above — some may require infrastructure changes
            (e.g. LDAP → external IdP API, filesystem → object storage)</li>
          <li>Once blockers are resolved, re-run AtlasReforge — the script may then qualify
            for an automated Forge or Automation migration</li>
          <li>Alternatively, use the business logic summary in the Summary tab as a
            spec for a manual rewrite</li>
        </ol>
      </div>

      {/* What the original script does */}
      <div style={{ padding: '16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '8px' }}>
          📋 Original script purpose
        </h3>
        <p style={{ fontSize: '13px', color: '#6b7280', margin: '0 0 8px', lineHeight: 1.6 }}>
          {result.businessLogic?.triggerDescription ?? 'Analysis not available'}
        </p>
        <p style={{ fontSize: '13px', color: '#374151', margin: 0, lineHeight: 1.6 }}>
          {result.businessLogic?.purposeNarrative ?? 'No business logic summary available.'}
        </p>
      </div>
    </div>
  );
}

// ─── Workspace page ───────────────────────────────────────────────────────────

export function WorkspacePage(): React.ReactElement {
  const { jobId } = useParams<{ jobId: string }>();
  const { status, progress, currentStage, result, error } = useJobPolling(jobId ?? null);
  const registry = useRegistry(jobId ?? null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('summary');
  const [activeTarget, setActiveTarget] = useState<'forge' | 'scriptrunner'>('forge');

  const isCompleted = status === 'completed';
  const isFailed    = status === 'failed';
  const isProcessing = !isCompleted && !isFailed;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f9fafb' }}>
      {/* Top nav */}
      <header style={HEADER_STYLE}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '20px' }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: '16px', color: '#111827' }}>AtlasReforge</span>
          {result !== null && (
            <>
              <span style={{ color: '#d1d5db' }}>/</span>
              <span style={{ fontSize: '14px', color: '#374151', fontFamily: 'monospace' }}>{result.originalFilename}</span>
              <ReadinessBadge level={result.cloudReadinessLevel} score={result.cloudReadinessScore} size="sm" />
            </>
          )}
        </div>

        {/* Tabs */}
        {isCompleted && result !== null && (
          <nav style={{ display: 'flex', gap: '2px' }}>
            {(
              [
                'summary',
                // Show Automation tab only when automationRule present
                ...(result.automationRule !== null ? ['automation'] : []),
                // Show Manual Rewrite tab only when target is manual-rewrite
                ...(result.recommendedTarget === 'manual-rewrite' ? ['manual-rewrite'] : []),
                // Hide Forge/SR tabs for automation-native and manual-rewrite
                ...(result.recommendedTarget !== 'automation-native' && result.recommendedTarget !== 'manual-rewrite'
                  ? ['forge', 'scriptrunner'] : []),
                'diagram',
              ] as ActiveTab[]
            ).map(tab => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); }}
                style={{
                  ...NAV_TAB_STYLE,
                  background: activeTab === tab ? '#fff' : 'transparent',
                  color: activeTab === tab
                    ? (tab === 'automation' ? '#1d4ed8' : '#1d4ed8')
                    : '#6b7280',
                  borderBottom: activeTab === tab
                    ? `2px solid ${tab === 'automation' ? '#3b82f6' : '#3b82f6'}`
                    : '2px solid transparent',
                  fontWeight: tab === 'automation' && activeTab !== 'automation' ? 600 : undefined,
                }}
              >
                {{
                  summary: '📋 Summary',
                  forge: '⚡ Forge',
                  scriptrunner: '📜 ScriptRunner',
                  automation: '🔵 Automation',
                  'manual-rewrite': '🔴 Manual Rewrite',
                  diagram: '📊 Diagram',
                }[tab]}
              </button>
            ))}
          </nav>
        )}

        <div style={{ fontSize: '12px', color: '#9ca3af' }}>
          {jobId?.slice(0, 8)}...
        </div>
      </header>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left sidebar — Registry */}
        <aside style={SIDEBAR_STYLE}>
          {isProcessing && (
            <div style={{ padding: '16px' }}>
              <ProgressPipeline
                status={status ?? 'queued'}
                progress={progress}
                currentStage={currentStage}
              />
              {error !== null && (
                <div style={{ marginTop: '12px', padding: '10px', background: '#fee2e2', borderRadius: '6px', fontSize: '13px', color: '#b91c1c' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {registry.session !== null && (
            <RegistryPanel
              session={registry.session}
              onUpdateField={registry.updateField}
              onUpdateGroup={registry.updateGroup}
              onUpdateUser={registry.updateUser}
              onSkip={registry.skip}
              onValidate={registry.validate}
              onExport={registry.exportSession}
              loading={registry.loading}
            />
          )}

          {registry.session === null && !isProcessing && (
            <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '13px' }}>
              Loading registry...
            </div>
          )}
        </aside>

        {/* Main content */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, padding: '16px', gap: '0' }}>
          {isProcessing && (
            <PipelineProgress currentStage={currentStage || 'starting'} progress={progress} />
          )}

          {isFailed && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ padding: '32px', background: '#fee2e2', borderRadius: '12px', textAlign: 'center', maxWidth: '480px' }}>
                <div style={{ fontSize: '40px', marginBottom: '12px' }}>❌</div>
                <h2 style={{ color: '#b91c1c', margin: '0 0 8px' }}>Migration failed</h2>
                <p style={{ color: '#dc2626', fontSize: '14px' }}>{error ?? 'An unexpected error occurred'}</p>
              </div>
            </div>
          )}

          {isCompleted && result !== null && (
            <>
              {activeTab === 'summary' && <SummaryTab result={result} />}

              {(activeTab === 'forge' || activeTab === 'scriptrunner') && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <button
                      onClick={() => { setActiveTarget('forge'); setActiveTab('forge'); }}
                      style={{ ...TAB_BTN(activeTarget === 'forge') }}>
                      ⚡ Forge
                    </button>
                    <button
                      onClick={() => { setActiveTarget('scriptrunner'); setActiveTab('scriptrunner'); }}
                      style={{ ...TAB_BTN(activeTarget === 'scriptrunner') }}>
                      📜 ScriptRunner Cloud
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <SplitEditor
                      originalContent={result.originalContent || `// Original: ${result.originalFilename}\n// Loading content...`}
                      originalFilename={result.originalFilename}
                      generatedFiles={result.forgeFiles}
                      scriptRunnerCode={result.scriptRunnerCode}
                      validationIssues={result.validationIssues}
                      activeTarget={activeTarget}
                    />
                  </div>
                </div>
              )}

              {activeTab === 'automation' && result.automationRule !== null && (
                <AutomationTab rule={result.automationRule} />
              )}

              {activeTab === 'automation' && result.automationRule === null && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '32px' }}>🔵</span>
                  <span style={{ fontSize: '14px' }}>No automation rule available for this migration target.</span>
                </div>
              )}

              {activeTab === 'manual-rewrite' && (
                <ManualRewriteTab result={result} />
              )}

              {activeTab === 'diagram' && (
                <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
                  <MermaidDiagram
                    source={result.diagram.mermaidSource}
                    title={result.diagram.title}
                  />
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 16px',
  height: '52px',
  background: '#fff',
  borderBottom: '1px solid #e5e7eb',
  flexShrink: 0,
};

const SIDEBAR_STYLE: React.CSSProperties = {
  width: '340px',
  flexShrink: 0,
  background: '#fff',
  borderRight: '1px solid #e5e7eb',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const NAV_TAB_STYLE: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: '13px',
  border: 'none',
  cursor: 'pointer',
  borderRadius: '6px 6px 0 0',
  fontWeight: 500,
  transition: 'color 0.15s',
};

const TAB_BTN = (active: boolean): React.CSSProperties => ({
  fontSize: '13px',
  padding: '6px 14px',
  border: `1px solid ${active ? '#3b82f6' : '#d1d5db'}`,
  borderRadius: '6px',
  background: active ? '#eff6ff' : '#fff',
  color: active ? '#1d4ed8' : '#374151',
  cursor: 'pointer',
  fontWeight: active ? 600 : 400,
});
