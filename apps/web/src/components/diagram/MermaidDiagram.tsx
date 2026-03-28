/**
 * MermaidDiagram
 *
 * Renders a Mermaid.js diagram from a mermaidSource string.
 * Loads Mermaid lazily to avoid adding it to the initial bundle.
 * Re-renders when mermaidSource changes.
 *
 * SECURITY: We use Mermaid's securityLevel 'strict' to prevent XSS
 * from LLM-generated diagram source. The LLM output goes through
 * the S5 validator but an extra layer of defence is always correct.
 */

import React, { useEffect, useRef, useState } from 'react';

interface Props {
  source: string;
  title?: string;
}

let mermaidInitialized = false;

async function getMermaid(): Promise<typeof import('mermaid').default> {
  const mermaid = (await import('mermaid')).default;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
    mermaidInitialized = true;
  }
  return mermaid;
}

let diagramCounter = 0;

export function MermaidDiagram({ source, title }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (containerRef.current === null || source.trim() === '') return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const mermaid = await getMermaid();
        const id = `mermaid-${++diagramCounter}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled && containerRef.current !== null) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Diagram render failed';
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [source]);

  if (source.trim() === '') {
    return (
      <div style={EMPTY_STYLE}>
        <span>No diagram available</span>
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      {title !== undefined && (
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '12px' }}>
          {title}
        </h3>
      )}

      {loading && (
        <div style={LOADING_STYLE}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
          {' '}Rendering diagram...
        </div>
      )}

      {error !== null && (
        <div style={ERROR_STYLE}>
          <strong>Diagram error:</strong> {error}
          <details style={{ marginTop: '8px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '12px' }}>Show source</summary>
            <pre style={{ fontSize: '11px', marginTop: '8px', overflow: 'auto' }}>{source}</pre>
          </details>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          width: '100%',
          overflow: 'auto',
          display: loading || error !== null ? 'none' : 'block',
        }}
      />
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {
  padding: '24px',
  textAlign: 'center',
  color: '#9ca3af',
  fontSize: '14px',
  background: '#f9fafb',
  borderRadius: '8px',
  border: '1px dashed #e5e7eb',
};

const LOADING_STYLE: React.CSSProperties = {
  padding: '24px',
  textAlign: 'center',
  color: '#6b7280',
  fontSize: '14px',
};

const ERROR_STYLE: React.CSSProperties = {
  padding: '12px 16px',
  background: '#fef2f2',
  border: '1px solid #fca5a5',
  borderRadius: '8px',
  color: '#b91c1c',
  fontSize: '13px',
};
