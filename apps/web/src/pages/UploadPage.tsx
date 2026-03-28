/**
 * UploadPage — the landing / drag-and-drop ingestion page
 */

import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { submitJob } from '../lib/api-client.js';

const ALLOWED_EXTS = ['.groovy', '.java', '.sil', '.xml', '.txt'];
const XML_EXTS = ['.xml'];
const MAX_SIZE_STANDARD = 512 * 1024;   // 512 KB for .groovy/.sil/.java
const MAX_SIZE_XML = 2 * 1024 * 1024;   // 2 MB for workflow XML (multiple scripts)

export function UploadPage(): React.ReactElement {
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      setError(`File type "${ext}" not supported. Use: .groovy, .java, .sil, .xml`);
      return;
    }
    const isXml = XML_EXTS.includes(ext);
    const maxSize = isXml ? MAX_SIZE_XML : MAX_SIZE_STANDARD;
    if (file.size > maxSize) {
      setError(isXml ? 'Workflow XML exceeds 2 MB limit' : 'File exceeds 512 KB limit');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const { jobId } = await submitJob(file);
      void navigate(`/workspace/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }, [navigate]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file !== undefined) void handleFile(file);
  }, [handleFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file !== undefined) void handleFile(file);
  }, [handleFile]);

  return (
    <div style={PAGE_STYLE}>
      {/* Hero */}
      <div style={{ textAlign: 'center', marginBottom: '48px' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚡</div>
        <h1 style={{ fontSize: '36px', fontWeight: 800, color: '#111827', margin: '0 0 12px' }}>
          AtlasReforge AI
        </h1>
        <p style={{ fontSize: '18px', color: '#6b7280', maxWidth: '560px', margin: '0 auto', lineHeight: 1.6 }}>
          Migrate Atlassian Server scripts (Groovy, Java, SIL) to Cloud automatically.
          Upload a script file or a Jira workflow XML export to get production-ready Forge code.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e: React.DragEvent) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => { setDragging(false); }}
        onDrop={handleDrop}
        onClick={() => { fileInputRef.current?.click(); }}
        style={{
          border: `2px dashed ${dragging ? '#3b82f6' : '#d1d5db'}`,
          borderRadius: '16px',
          padding: '64px 32px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? '#eff6ff' : '#f9fafb',
          transition: 'all 0.15s',
          maxWidth: '560px',
          width: '100%',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".groovy,.java,.sil,.xml,.txt"
          onChange={handleInputChange}
          style={{ display: 'none' }}
        />
        {submitting ? (
          <div style={{ color: '#3b82f6', fontSize: '16px' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>⟳</div>
            Parsing and submitting...
          </div>
        ) : (
          <>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📂</div>
            <p style={{ fontSize: '18px', fontWeight: 600, color: '#374151', margin: '0 0 8px' }}>
              Drop your script here
            </p>
            <p style={{ fontSize: '14px', color: '#9ca3af', margin: '0 0 8px' }}>
              .groovy, .java, .sil — single script (512 KB max)
            </p>
            <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>
              .xml — Jira workflow export (extracts all embedded scripts, 2 MB max)
            </p>
          </>
        )}
      </div>

      {error !== null && (
        <div style={{ marginTop: '16px', padding: '12px 16px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '8px', color: '#b91c1c', fontSize: '14px', maxWidth: '560px', width: '100%' }}>
          {error}
        </div>
      )}

      {/* Feature pills */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '40px' }}>
        {[
          '🟢 Cloud Readiness Score',
          '🔧 Field Mapping Registry',
          '⚡ Forge + ScriptRunner',
          '📋 Workflow XML import',
          '🔒 Ephemeral Processing',
          '📊 ROI Calculator',
        ].map(f => (
          <span key={f} style={{ fontSize: '13px', padding: '6px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '9999px', color: '#374151', fontWeight: 500 }}>
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 16px',
  background: 'linear-gradient(135deg, #f0f9ff 0%, #f9fafb 100%)',
};
