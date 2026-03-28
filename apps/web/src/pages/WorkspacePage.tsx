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
import type { ActiveTab } from '../types/index.js';

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
      {requiresHumanReview && <span title={note} style={{ fontSize: '13px', cursor: 'help' }}>👁</span>}
    </div>
  );
}

// ─── Summary tab ─────────────────────────────────────────────────────────────

function SummaryTab({ result }: { result: NonNullable<ReturnType<typeof useJobPolling>['result']> }): React.ReactElement {
  return (
    <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
        <ReadinessBadge level={result.cloudReadinessLevel} score={result.cloudReadinessScore} size="lg" />
        <span style={{ fontSize: '13px', color: '#6b7280' }}>→ {result.recommendedTarget}</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>•</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{result.complexity} complexity</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>•</span>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{result.linesOfCode} LOC</span>
      </div>

      <RoiBar
        consultantHours={15}
        aiHours={3.5}
        savingsPercent={76}
      />

      <div style={{ marginTop: '20px', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>Business Logic</h3>
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#374151', fontWeight: 500 }}>
            {result.businessLogic.triggerDescription}
          </p>
          <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#6b7280', lineHeight: 1.6 }}>
            {result.businessLogic.purposeNarrative}
          </p>
          {result.businessLogic.inputConditions.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ fontSize: '12px', color: '#374151' }}>Conditions:</strong>
              {result.businessLogic.inputConditions.map((c, i) => (
                <div key={i} style={{ fontSize: '12px', color: '#6b7280', marginLeft: '12px' }}>• {c}</div>
              ))}
            </div>
          )}
          {result.businessLogic.outputActions.length > 0 && (
            <div>
              <strong style={{ fontSize: '12px', color: '#374151' }}>Actions:</strong>
              {result.businessLogic.outputActions.map((a, i) => (
                <div key={i} style={{ fontSize: '12px', color: '#6b7280', marginLeft: '12px' }}>• {a}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>Confidence Scores</h3>
        <ConfidenceRow label="Field Mapping"   {...result.confidence.fieldMapping}   />
        <ConfidenceRow label="Webhook Logic"   {...result.confidence.webhookLogic}   />
        <ConfidenceRow label="User Resolution" {...result.confidence.userResolution} />
        <ConfidenceRow label="OAuth Scopes"    {...result.confidence.oauthScopes}    />
        <ConfidenceRow label="Overall"         {...result.confidence.overallMigration} />
      </div>

      {result.oauthScopes.length > 0 && (
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
            {(['summary', 'forge', 'scriptrunner', 'diagram'] as ActiveTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); }}
                style={{
                  ...NAV_TAB_STYLE,
                  background: activeTab === tab ? '#fff' : 'transparent',
                  color: activeTab === tab ? '#1d4ed8' : '#6b7280',
                  borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                }}
              >
                {{
                  summary: '📋 Summary',
                  forge: '⚡ Forge',
                  scriptrunner: '📜 ScriptRunner',
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
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '16px', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '48px' }}>⟳</div>
              <span>Processing your script...</span>
              <span style={{ fontSize: '14px' }}>Stage: {currentStage || 'starting'} ({progress}%)</span>
            </div>
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
                      originalContent={`// Original: ${result.originalFilename}\n// Language detected — upload original file to see content here`}
                      originalFilename={result.originalFilename}
                      generatedFiles={result.forgeFiles}
                      scriptRunnerCode={result.scriptRunnerCode}
                      validationIssues={result.validationIssues}
                      activeTarget={activeTarget}
                    />
                  </div>
                </div>
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
