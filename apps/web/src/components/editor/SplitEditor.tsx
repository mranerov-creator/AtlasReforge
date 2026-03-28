/**
 * SplitEditor
 *
 * The main workspace editor: Monaco split view.
 *   Left:  Original Server/DC script (read-only, deprecated APIs highlighted in red)
 *   Right: Generated Cloud code (editable for manual refinement)
 *
 * Features:
 *   - Language detection → Monaco syntax highlight (groovy, java, typescript, yaml)
 *   - Deprecated API markers: red squiggles on ComponentAccessor, getUserByName, etc.
 *   - Tab selection between generated files (manifest.yml, src/index.ts, etc.)
 *   - Copy button per file
 */

import React, { useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import type { GeneratedFile, ValidationIssue } from '../../types/index.js';

interface Props {
  originalContent: string;
  originalFilename: string;
  generatedFiles: GeneratedFile[] | null;
  scriptRunnerCode: GeneratedFile | null;
  validationIssues: ValidationIssue[];
  activeTarget: 'forge' | 'scriptrunner';
}

const DEPRECATED_PATTERNS = [
  'ComponentAccessor',
  'IssueManager',
  'UserManager',
  'GroupManager',
  'getUserByName',
  'getUsername()',
  'java.io.File',
  'OfBizDelegator',
  'EntityCondition',
  '/rest/api/2/',
];

// Map file extensions to Monaco language IDs
function detectLanguage(filename: string | undefined): string {
  if (!filename) return 'plaintext';
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    groovy: 'groovy', java: 'java',
    yml: 'yaml', yaml: 'yaml',
    json: 'json', sil: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 2000);
  }, [text]);
  return (
    <button onClick={handleCopy} style={COPY_BTN_STYLE}>
      {copied ? '✓ Copied' : '⎘ Copy'}
    </button>
  );
}

function EditorPanel({
  title,
  filename,
  content,
  readOnly,
  validationIssues = [],
}: {
  title: string;
  filename: string;
  content: string;
  readOnly?: boolean;
  validationIssues?: ValidationIssue[];
}): React.ReactElement {
  const language = detectLanguage(filename);
  const errorCount = validationIssues.filter(i => i.severity === 'error' && !i.autoFixed).length;
  const warnCount  = validationIssues.filter(i => i.severity === 'warning').length;
  const fixedCount = validationIssues.filter(i => i.autoFixed).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      {/* Panel header */}
      <div style={PANEL_HEADER_STYLE}>
        <div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#111827' }}>{title}</span>
          <span style={{ marginLeft: '8px', fontSize: '12px', color: '#6b7280' }}>{filename}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {fixedCount > 0 && (
            <span style={{ fontSize: '11px', color: '#15803d', background: '#dcfce7', padding: '2px 6px', borderRadius: '4px' }}>
              {fixedCount} auto-fixed
            </span>
          )}
          {errorCount > 0 && (
            <span style={{ fontSize: '11px', color: '#b91c1c', background: '#fee2e2', padding: '2px 6px', borderRadius: '4px' }}>
              {errorCount} errors
            </span>
          )}
          {warnCount > 0 && (
            <span style={{ fontSize: '11px', color: '#a16207', background: '#fef9c3', padding: '2px 6px', borderRadius: '4px' }}>
              {warnCount} warnings
            </span>
          )}
          <CopyButton text={content} />
        </div>
      </div>

      {/* Monaco Editor */}
      <div style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
        <Editor
          height="100%"
          language={language}
          value={content}
          options={{
            readOnly: readOnly ?? false,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            theme: 'vs',
            renderValidationDecorations: 'on',
            padding: { top: 8, bottom: 8 },
          }}
          beforeMount={(monaco) => {
            // Register groovy as plaintext with custom theme tokens
            if (!monaco.languages.getLanguages().find(l => l.id === 'groovy')) {
              monaco.languages.register({ id: 'groovy' });
            }

            // Add red decorations for deprecated API patterns in read-only panel
            if (readOnly === true) {
              monaco.editor.addEditorAction({
                id: 'atlasreforge.markDeprecated',
                label: 'Mark deprecated',
                run: () => { /* no-op — decorations applied via onMount */ },
              });
            }
          }}
          onMount={(editor, monaco) => {
            if (!readOnly) return;
            // Apply red decorations to deprecated API usages
            const model = editor.getModel();
            if (model === null) return;

            const decorations = DEPRECATED_PATTERNS.flatMap((pattern) => {
              const matches = model.findMatches(pattern, true, false, false, null, true);
              return matches.map(m => ({
                range: m.range,
                options: {
                  inlineClassName: 'deprecated-api-highlight',
                  hoverMessage: { value: `⚠️ \`${pattern}\` is deprecated in Cloud` },
                  className: 'deprecated-api-highlight',
                  overviewRuler: {
                    color: '#ef4444',
                    position: monaco.editor.OverviewRulerLane.Right,
                  },
                },
              }));
            });

            editor.createDecorationsCollection(decorations);
          }}
        />
      </div>
    </div>
  );
}

export function SplitEditor({
  originalContent,
  originalFilename,
  generatedFiles,
  scriptRunnerCode,
  validationIssues,
  activeTarget,
}: Props): React.ReactElement {
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);

  const targetFiles = activeTarget === 'forge' ? (generatedFiles ?? []) :
    scriptRunnerCode !== null ? [scriptRunnerCode] : [];
  const selectedFile = targetFiles[selectedFileIdx] ?? null;

  // Reset selection when files change
  React.useEffect(() => {
    setSelectedFileIdx(0);
  }, [activeTarget]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0' }}>
      {/* File tabs for generated files */}
      {targetFiles.length > 1 && (
        <div style={TABS_STYLE}>
          {targetFiles.map((file, i) => (
            <button
              key={file.filename}
              onClick={() => { setSelectedFileIdx(i); }}
              style={{
                ...TAB_BTN_STYLE,
                background: i === selectedFileIdx ? '#fff' : 'transparent',
                borderBottom: i === selectedFileIdx ? '2px solid #3b82f6' : '2px solid transparent',
                color: i === selectedFileIdx ? '#1d4ed8' : '#6b7280',
              }}
            >
              {file.filename}
            </button>
          ))}
        </div>
      )}

      {/* Split panel */}
      <div style={{ display: 'flex', flex: 1, gap: '8px', minHeight: 0 }}>
        <EditorPanel
          title="Legacy (Server/DC)"
          filename={originalFilename}
          content={originalContent}
          readOnly
        />
        <EditorPanel
          title={activeTarget === 'forge' ? 'Generated — Forge' : 'Generated — ScriptRunner Cloud'}
          filename={selectedFile?.filename ?? 'No output'}
          content={selectedFile?.content ?? '// No code generated yet'}
          validationIssues={validationIssues.filter(
            i => selectedFile !== null && i.file === selectedFile.filename,
          )}
        />
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const PANEL_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 12px',
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '8px 8px 0 0',
  minHeight: '40px',
};

const COPY_BTN_STYLE: React.CSSProperties = {
  fontSize: '12px',
  padding: '3px 10px',
  borderRadius: '6px',
  border: '1px solid #d1d5db',
  background: '#fff',
  cursor: 'pointer',
  color: '#374151',
};

const TABS_STYLE: React.CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid #e5e7eb',
  background: '#f9fafb',
  paddingLeft: '8px',
  flexShrink: 0,
};

const TAB_BTN_STYLE: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: '12px',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'ui-monospace, monospace',
  transition: 'color 0.15s',
};
