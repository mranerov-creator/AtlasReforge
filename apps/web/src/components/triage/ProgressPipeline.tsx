/**
 * ProgressPipeline
 * Shows the 5-stage pipeline progress as a horizontal stepper.
 */

import React from 'react';
import type { JobStatus } from '../../types/index.js';

interface Props {
  status: JobStatus;
  progress: number;
  currentStage: string;
}

const STAGES = [
  { key: 'classifying', label: 'Classify',  icon: '🔍' },
  { key: 'extracting',  label: 'Extract',   icon: '🔬' },
  { key: 'retrieving',  label: 'Retrieve',  icon: '📚' },
  { key: 'generating',  label: 'Generate',  icon: '⚡' },
  { key: 'validating',  label: 'Validate',  icon: '✅' },
] as const;

type StageStatus = 'done' | 'active' | 'pending';

function getStageStatus(stageKey: string, currentStage: string, status: JobStatus): StageStatus {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'pending';
  const stageOrder = STAGES.map(s => s.key);
  const currentIdx = stageOrder.indexOf(currentStage as typeof stageOrder[number]);
  const stageIdx = stageOrder.indexOf(stageKey as typeof stageOrder[number]);
  if (stageIdx < currentIdx) return 'done';
  if (stageIdx === currentIdx) return 'active';
  return 'pending';
}

export function ProgressPipeline({ status, progress, currentStage }: Props): React.ReactElement {
  const isTerminal = status === 'completed' || status === 'failed';

  return (
    <div style={{ padding: '16px 0' }}>
      {/* Progress bar */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
          <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>
            {status === 'completed' ? '✅ Migration complete' :
             status === 'failed'    ? '❌ Pipeline failed' :
             `Processing: ${currentStage || 'starting'}...`}
          </span>
          <span style={{ fontSize: '13px', color: '#6b7280' }}>{progress}%</span>
        </div>
        <div style={{
          height: '6px',
          background: '#e5e7eb',
          borderRadius: '9999px',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: status === 'failed' ? '#ef4444' :
                        status === 'completed' ? '#22c55e' : '#3b82f6',
            borderRadius: '9999px',
            transition: 'width 0.3s ease',
          }} />
        </div>
      </div>

      {/* Stage steps */}
      <div style={{ display: 'flex', gap: '0', alignItems: 'center' }}>
        {STAGES.map((stage, i) => {
          const stageStatus = getStageStatus(stage.key, currentStage, status);
          const isLast = i === STAGES.length - 1;

          return (
            <React.Fragment key={stage.key}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  background: stageStatus === 'done'   ? '#22c55e' :
                              stageStatus === 'active' ? '#3b82f6' : '#e5e7eb',
                  color: stageStatus === 'pending' ? '#9ca3af' : '#fff',
                  fontWeight: 600,
                  transition: 'background 0.3s',
                  border: stageStatus === 'active' ? '2px solid #1d4ed8' : '2px solid transparent',
                }}>
                  {stageStatus === 'done' ? '✓' : stage.icon}
                </div>
                <span style={{
                  fontSize: '11px',
                  marginTop: '4px',
                  color: stageStatus === 'pending' ? '#9ca3af' : '#374151',
                  fontWeight: stageStatus === 'active' ? 600 : 400,
                }}>
                  {stage.label}
                </span>
              </div>

              {!isLast && (
                <div style={{
                  height: '2px',
                  flex: 1,
                  background: stageStatus === 'done' ? '#22c55e' : '#e5e7eb',
                  marginBottom: '16px',
                  transition: 'background 0.3s',
                }} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
