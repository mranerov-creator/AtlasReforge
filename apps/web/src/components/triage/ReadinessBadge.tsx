/**
 * ReadinessBadge
 * The 🟢🟡🔴 semaphore badge for cloud readiness.
 */

import React from 'react';
import type { CloudReadinessLevel } from '../../types/index.js';

interface Props {
  level: CloudReadinessLevel;
  score?: number;
  size?: 'sm' | 'md' | 'lg';
}

const CONFIG = {
  green:  { emoji: '🟢', label: 'Cloud Ready',       bg: '#dcfce7', fg: '#15803d', border: '#86efac' },
  yellow: { emoji: '🟡', label: 'Paradigm Shift',    bg: '#fef9c3', fg: '#a16207', border: '#fde047' },
  red:    { emoji: '🔴', label: 'Architectural Gap', bg: '#fee2e2', fg: '#b91c1c', border: '#fca5a5' },
} as const;

const SIZE = {
  sm: { fontSize: '11px', padding: '2px 6px', emojiSize: '12px' },
  md: { fontSize: '13px', padding: '4px 10px', emojiSize: '14px' },
  lg: { fontSize: '15px', padding: '6px 14px', emojiSize: '18px' },
};

export function ReadinessBadge({ level, score, size = 'md' }: Props): React.ReactElement {
  // Guard: if level is missing or unexpected, default to 'red'
  const safeLevel = (level && level in CONFIG) ? level : 'red';
  const { emoji, label, bg, fg, border } = CONFIG[safeLevel];
  const { fontSize, padding, emojiSize } = SIZE[size];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        backgroundColor: bg,
        color: fg,
        border: `1px solid ${border}`,
        borderRadius: '9999px',
        padding,
        fontSize,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: emojiSize }}>{emoji}</span>
      {label}
      {score !== undefined && (
        <span style={{ opacity: 0.75, fontWeight: 400 }}>({score}/100)</span>
      )}
    </span>
  );
}

