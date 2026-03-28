/**
 * RegistryPanel
 *
 * The Field Mapping Registry UI. Shows all detected dependencies
 * and lets the user map Server IDs → Cloud IDs before code generation.
 *
 * Sections:
 *   1. Custom Fields — customfield_XXXXX → Cloud field ID
 *   2. Groups — Server group name → Cloud group ID
 *   3. Users (GDPR) — username → accountId
 *   4. Completion status + blockers
 */

import React, { useState } from 'react';
import type { RegistrySession, CustomFieldMapping, GroupMapping, UserMapping } from '../../types/index.js';

interface Props {
  session: RegistrySession;
  onUpdateField: (serverFieldId: string, cloudFieldId: string, name?: string) => Promise<void>;
  onUpdateGroup: (serverGroupName: string, cloudGroupId: string, name?: string) => Promise<void>;
  onUpdateUser: (serverIdentifier: string, cloudAccountId: string, strategy: string, name?: string) => Promise<void>;
  onSkip: (type: 'customField' | 'group' | 'user', identifier: string) => Promise<void>;
  onValidate: (cloudBaseUrl: string, accessToken: string) => Promise<void>;
  onExport: () => Promise<void>;
  loading?: boolean;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const config = {
    unmapped:    { label: 'Unmapped',   bg: '#fee2e2', fg: '#b91c1c' },
    mapped:      { label: 'Mapped',     bg: '#dcfce7', fg: '#15803d' },
    'auto-mapped': { label: 'Auto',     bg: '#dbeafe', fg: '#1d4ed8' },
    skipped:     { label: 'Skipped',   bg: '#f3f4f6', fg: '#6b7280' },
  } as const;
  const { label, bg, fg } = config[status as keyof typeof config] ?? { label: status, bg: '#f3f4f6', fg: '#374151' };
  return (
    <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', background: bg, color: fg, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// ─── Inline mapping row ───────────────────────────────────────────────────────

function FieldRow({ field, onUpdate, onSkip }: {
  field: CustomFieldMapping;
  onUpdate: (cloudId: string, name?: string) => Promise<void>;
  onSkip: () => Promise<void>;
}): React.ReactElement {
  const [cloudId, setCloudId] = useState(field.cloudFieldId ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (cloudId.trim() === '') return;
    setSaving(true);
    try { await onUpdate(cloudId.trim()); } finally { setSaving(false); }
  };

  return (
    <div style={ROW_STYLE}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <code style={CODE_STYLE}>{field.serverFieldId}</code>
          <StatusBadge status={field.status} />
          <span style={{ fontSize: '11px', color: '#6b7280' }}>{field.usageType}</span>
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>
          {field.probableBusinessPurpose}
        </div>
        {field.status !== 'skipped' && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Cloud field ID (e.g. customfield_10201)"
              value={cloudId}
              onChange={e => { setCloudId(e.target.value); }}
              style={INPUT_STYLE}
            />
            <button onClick={() => { void handleSave(); }} disabled={saving || cloudId.trim() === ''} style={BTN_PRIMARY}>
              {saving ? '...' : 'Save'}
            </button>
            <button onClick={() => { void onSkip(); }} style={BTN_GHOST}>Skip</button>
          </div>
        )}
        {field.validatedAt !== null && (
          <div style={{ fontSize: '11px', color: '#15803d', marginTop: '4px' }}>
            ✓ Validated against Cloud API
          </div>
        )}
      </div>
    </div>
  );
}

function GroupRow({ group, onUpdate, onSkip }: {
  group: GroupMapping;
  onUpdate: (cloudId: string, name?: string) => Promise<void>;
  onSkip: () => Promise<void>;
}): React.ReactElement {
  const [cloudId, setCloudId] = useState(group.cloudGroupId ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (cloudId.trim() === '') return;
    setSaving(true);
    try { await onUpdate(cloudId.trim()); } finally { setSaving(false); }
  };

  return (
    <div style={ROW_STYLE}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <code style={CODE_STYLE}>{group.serverGroupName}</code>
          <StatusBadge status={group.status} />
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>{group.probableRole}</div>
        {group.status !== 'skipped' && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              placeholder="Cloud group ID (UUID)"
              value={cloudId}
              onChange={e => { setCloudId(e.target.value); }}
              style={INPUT_STYLE}
            />
            <button onClick={() => { void handleSave(); }} disabled={saving || cloudId.trim() === ''} style={BTN_PRIMARY}>
              {saving ? '...' : 'Save'}
            </button>
            <button onClick={() => { void onSkip(); }} style={BTN_GHOST}>Skip</button>
          </div>
        )}
      </div>
    </div>
  );
}

function UserRow({ user, onUpdate, onSkip }: {
  user: UserMapping;
  onUpdate: (accountId: string, strategy: string, name?: string) => Promise<void>;
  onSkip: () => Promise<void>;
}): React.ReactElement {
  const [accountId, setAccountId] = useState(user.cloudAccountId ?? '');
  const [strategy, setStrategy] = useState(user.resolutionStrategy === 'pending' ? 'migration-api' : user.resolutionStrategy);
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    if (accountId.trim() === '') return;
    setSaving(true);
    try { await onUpdate(accountId.trim(), strategy); } finally { setSaving(false); }
  };

  const gdprColor = { high: '#ef4444', medium: '#f97316', low: '#22c55e' }[user.gdprRisk] ?? '#6b7280';

  return (
    <div style={ROW_STYLE}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <code style={CODE_STYLE}>{user.serverIdentifier}</code>
          <StatusBadge status={user.status} />
          <span style={{ fontSize: '11px', color: gdprColor, fontWeight: 600 }}>
            ⚠ GDPR {user.gdprRisk}
          </span>
        </div>
        {user.status !== 'skipped' && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
            <input
              type="text"
              placeholder="Cloud accountId"
              value={accountId}
              onChange={e => { setAccountId(e.target.value); }}
              style={{ ...INPUT_STYLE, flex: 2 }}
            />
            <select value={strategy} onChange={e => { setStrategy(e.target.value); }} style={SELECT_STYLE}>
              <option value="migration-api">Migration API</option>
              <option value="manual-lookup">Manual lookup</option>
              <option value="service-account">Service account</option>
              <option value="remove">Remove</option>
            </select>
            <button onClick={() => { void handleSave(); }} disabled={saving || accountId.trim() === ''} style={BTN_PRIMARY}>
              {saving ? '...' : 'Save'}
            </button>
            <button onClick={() => { void onSkip(); }} style={BTN_GHOST}>Skip</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function RegistryPanel({
  session,
  onUpdateField,
  onUpdateGroup,
  onUpdateUser,
  onSkip,
  onValidate,
  onExport,
  loading = false,
}: Props): React.ReactElement {
  const [validateForm, setValidateForm] = useState({ cloudBaseUrl: '', accessToken: '', open: false });
  const [validating, setValidating] = useState(false);

  const handleValidate = async (): Promise<void> => {
    if (validateForm.cloudBaseUrl === '' || validateForm.accessToken === '') return;
    setValidating(true);
    try {
      await onValidate(validateForm.cloudBaseUrl, validateForm.accessToken);
      setValidateForm(f => ({ ...f, open: false }));
    } finally { setValidating(false); }
  };

  const unmappedCount = session.completionBlockers.length;
  const totalCount = session.customFields.length + session.groups.length + session.users.length;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '0 2px' }}>
      {/* Header */}
      <div style={{ padding: '16px', borderBottom: '1px solid #e5e7eb', background: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#111827' }}>
              Field Mapping Registry
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#6b7280' }}>
              {session.isComplete
                ? '✅ All mappings resolved — code generation ready'
                : `${unmappedCount} of ${totalCount} items need mapping`}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setValidateForm(f => ({ ...f, open: !f.open })); }} style={BTN_SECONDARY}>
              🔗 Validate vs Cloud
            </button>
            <button onClick={() => { void onExport(); }} style={BTN_GHOST}>
              ⬇ Export
            </button>
          </div>
        </div>

        {/* Validate form */}
        {validateForm.open && (
          <div style={{ marginTop: '12px', padding: '12px', background: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="https://mycompany.atlassian.net"
                value={validateForm.cloudBaseUrl}
                onChange={e => { setValidateForm(f => ({ ...f, cloudBaseUrl: e.target.value })); }}
                style={{ ...INPUT_STYLE, flex: 2 }}
              />
              <input
                type="password"
                placeholder="OAuth access token"
                value={validateForm.accessToken}
                onChange={e => { setValidateForm(f => ({ ...f, accessToken: e.target.value })); }}
                style={{ ...INPUT_STYLE, flex: 2 }}
              />
              <button onClick={() => { void handleValidate(); }} disabled={validating} style={BTN_PRIMARY}>
                {validating ? 'Validating...' : 'Validate all'}
              </button>
            </div>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '6px', marginBottom: 0 }}>
              Token is never stored — used only for this validation request.
            </p>
          </div>
        )}
      </div>

      {/* Completion blockers */}
      {session.completionBlockers.length > 0 && (
        <div style={{ margin: '12px 16px 0', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#b91c1c', marginBottom: '6px' }}>
            Blockers preventing code generation:
          </div>
          {session.completionBlockers.map(b => (
            <div key={b.entityId} style={{ fontSize: '12px', color: '#dc2626', marginBottom: '2px' }}>
              • {b.message}
            </div>
          ))}
        </div>
      )}

      {/* Custom Fields section */}
      {session.customFields.length > 0 && (
        <Section title={`Custom Fields (${session.customFields.length})`} icon="🔧">
          {session.customFields.map(cf => (
            <FieldRow
              key={cf.serverFieldId}
              field={cf}
              onUpdate={(id, name) => onUpdateField(cf.serverFieldId, id, name)}
              onSkip={() => onSkip('customField', cf.serverFieldId)}
            />
          ))}
        </Section>
      )}

      {/* Groups section */}
      {session.groups.length > 0 && (
        <Section title={`Groups (${session.groups.length})`} icon="👥">
          {session.groups.map(g => (
            <GroupRow
              key={g.serverGroupName}
              group={g}
              onUpdate={(id, name) => onUpdateGroup(g.serverGroupName, id, name)}
              onSkip={() => onSkip('group', g.serverGroupName)}
            />
          ))}
        </Section>
      )}

      {/* Users section */}
      {session.users.length > 0 && (
        <Section title={`Users — GDPR Critical (${session.users.length})`} icon="👤">
          <div style={{ fontSize: '12px', color: '#a16207', padding: '8px 16px', background: '#fef9c3', borderRadius: '6px', margin: '0 0 8px' }}>
            All username/userKey references must be replaced with Cloud accountId before deployment.
          </div>
          {session.users.map(u => (
            <UserRow
              key={u.serverIdentifier}
              user={u}
              onUpdate={(id, strategy, name) => onUpdateUser(u.serverIdentifier, id, strategy, name)}
              onSkip={() => onSkip('user', u.serverIdentifier)}
            />
          ))}
        </Section>
      )}

      {totalCount === 0 && (
        <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '14px' }}>
          ✅ No hardcoded IDs detected — this script has no mapping requirements.
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ borderBottom: '1px solid #f3f4f6' }}>
      <button
        onClick={() => { setOpen(o => !o); }}
        style={{ width: '100%', textAlign: 'left', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 600, color: '#374151' }}
      >
        <span>{icon}</span>
        <span>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#9ca3af' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div style={{ padding: '0 16px 12px' }}>{children}</div>}
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const ROW_STYLE: React.CSSProperties = {
  padding: '10px 0',
  borderBottom: '1px solid #f3f4f6',
};
const CODE_STYLE: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '12px',
  background: '#f3f4f6',
  padding: '2px 6px',
  borderRadius: '4px',
  color: '#111827',
};
const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  fontSize: '12px',
  padding: '6px 10px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontFamily: 'ui-monospace, monospace',
  minWidth: 0,
};
const SELECT_STYLE: React.CSSProperties = {
  fontSize: '12px',
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  background: '#fff',
};
const BTN_PRIMARY: React.CSSProperties = {
  fontSize: '12px',
  padding: '6px 14px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};
const BTN_SECONDARY: React.CSSProperties = {
  fontSize: '12px',
  padding: '6px 12px',
  background: '#fff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  cursor: 'pointer',
};
const BTN_GHOST: React.CSSProperties = {
  fontSize: '12px',
  padding: '6px 10px',
  background: 'transparent',
  color: '#6b7280',
  border: '1px solid #e5e7eb',
  borderRadius: '6px',
  cursor: 'pointer',
};
