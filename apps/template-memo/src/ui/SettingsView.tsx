/*
 * 設定画面。テンプレート管理 / グループ / タグ / 定型文 / QR出力 / バックアップ /
 * 危険な操作 / このアプリについて を 1 画面に並べる。
 * テンプレート編集はルートを増やさず、この画面のローカル state で TemplateEditView へ切り替える。
 * 破壊的操作（削除・復元・全削除）は必ず ConfirmDialog を挟む（fail-closed）。
 */
import { useId, useState } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Button } from '@snishi/foundation/ui/Button';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import {
  addGroup,
  appendImported,
  deleteGroup,
  deleteSnippet,
  deleteTag,
  deleteTemplate,
  renameGroup,
  reorderGroup,
  replaceAll,
  saveSnippet,
  saveTag,
  saveTemplate,
  setActiveTemplate,
  sortedGroups,
  updateSettings,
  wipeAll,
  type ReplaceAllData,
} from '../data/store';
import { buildBackupJson, parseBackupJson } from '../domain/backup';
import {
  convertWorkspaceBackup,
  listImportCandidates,
  type WorkspaceImportCandidate,
  type WorkspaceImportData,
} from '../domain/importWorkspace';
import {
  buildDailyReportPreset,
  buildRoundPreset,
  normalizeTemplate,
  type Template,
} from '../domain/template';
import type { Group, NewlineMode, Snippet, Tag } from '../domain/types';
import { errorText, t } from '../i18n';
import { downloadTextFile, pickTextFile } from './files';
import { TemplateEditView } from './TemplateEditView';
import { TemplateQrReceiveDialog } from './TemplateQrReceiveDialog';
import { TemplateQrSendDialog } from './TemplateQrSendDialog';
import { useStore } from './useStore';

/** JSON の accept 指定（テンプレート・バックアップ共通）。 */
const JSON_ACCEPT = '.json,application/json';

/** バックアップファイル名用の YYYYMMDD。 */
function yyyymmdd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** ファイル名に使えない文字を退避する（テンプレ名 → ファイル名）。 */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned !== '' ? cleaned : 'template';
}

/** 確認ダイアログの対象（1 画面で 1 つだけ開く）。 */
type ConfirmState =
  | { kind: 'templateDelete'; template: Template }
  | { kind: 'groupDelete'; group: Group }
  | { kind: 'tagDelete'; tag: Tag }
  | { kind: 'snippetDelete'; snippet: Snippet }
  | { kind: 'backupImport'; data: ReplaceAllData }
  | { kind: 'workspaceImport'; data: WorkspaceImportData }
  | { kind: 'wipe' };

interface WorkspaceImportState {
  json: string;
  candidates: WorkspaceImportCandidate[];
  userId: string;
  data: WorkspaceImportData;
}

// ============================
// 行部品（改名 onBlur のためローカル draft を持つ）
// ============================

/** グループ 1 行: 名前 input（onBlur で確定）+ ↑↓ + 削除。 */
function GroupRow({
  group,
  isFirst,
  isLast,
  onDelete,
  onError,
}: {
  group: Group;
  isFirst: boolean;
  isLast: boolean;
  onDelete: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(group.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === group.name) {
      setName(group.name); // 空は捨てて元へ戻す
      return;
    }
    renameGroup(group.id, trimmed).catch(onError);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
      <input
        className="input"
        style={{ flex: 1, minWidth: 0 }}
        aria-label={t('settings.groupName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
      />
      <IconButton
        label={t('tpl.moveUp')}
        disabled={isFirst}
        onClick={() => void reorderGroup(group.id, -1).catch(onError)}
      >
        ↑
      </IconButton>
      <IconButton
        label={t('tpl.moveDown')}
        disabled={isLast}
        onClick={() => void reorderGroup(group.id, 1).catch(onError)}
      >
        ↓
      </IconButton>
      <IconButton label={t('common.delete')} onClick={onDelete}>
        <Icon name="delete" size={20} />
      </IconButton>
    </div>
  );
}

/** タグ 1 行: 名前 input（onBlur で確定）+ 削除。 */
function TagRow({
  tag,
  onDelete,
  onError,
}: {
  tag: Tag;
  onDelete: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(tag.name);
  const commit = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === tag.name) {
      setName(tag.name);
      return;
    }
    saveTag({ ...tag, name: trimmed }).catch(onError);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
      <input
        className="input"
        style={{ flex: 1, minWidth: 0 }}
        aria-label={t('settings.tagName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
      />
      <IconButton label={t('common.delete')} onClick={onDelete}>
        <Icon name="delete" size={20} />
      </IconButton>
    </div>
  );
}

/** 定型文 1 行: label input + body textarea（それぞれ onBlur で確定）+ 削除。 */
function SnippetRow({
  snippet,
  onDelete,
  onError,
}: {
  snippet: Snippet;
  onDelete: () => void;
  onError: (e: unknown) => void;
}) {
  const [label, setLabel] = useState(snippet.label);
  const [body, setBody] = useState(snippet.body);
  const commit = (nextLabel: string, nextBody: string) => {
    if (nextLabel === snippet.label && nextBody === snippet.body) return;
    saveSnippet({ id: snippet.id, label: nextLabel, body: nextBody }).catch(onError);
  };
  return (
    <div
      style={{
        borderTop: '1px solid var(--border, #e2e8f0)',
        paddingTop: 8,
        marginTop: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t('settings.snippetLabel')}
          placeholder={t('settings.snippetLabel')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => commit(label.trim(), body)}
        />
        <IconButton label={t('common.delete')} onClick={onDelete}>
          <Icon name="delete" size={20} />
        </IconButton>
      </div>
      <textarea
        className="tm-textarea"
        style={{ marginTop: 8 }}
        aria-label={t('settings.snippetBody')}
        placeholder={t('settings.snippetBody')}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => commit(label.trim(), body)}
      />
    </div>
  );
}

// ============================
// 本体
// ============================

export function SettingsView({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const { settings, templates, subjects, groups } = store;
  const toast = useToast();
  const radioName = useId();

  // テンプレート編集への切り替え（ルートは増やさない）。
  const [editing, setEditing] = useState<Template | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [qrSendTemplate, setQrSendTemplate] = useState<Template | null>(null);
  const [qrReceiveOpen, setQrReceiveOpen] = useState(false);
  const [workspaceImport, setWorkspaceImport] = useState<WorkspaceImportState | null>(null);
  const [workspaceImportApplying, setWorkspaceImportApplying] = useState(false);

  const showError = (e: unknown) => toast.show(errorText(e), 'error');

  // ---------- テンプレート ----------

  const onAddPreset = async (kind: 'round' | 'daily') => {
    try {
      const tpl =
        kind === 'round' ? buildRoundPreset(Date.now()) : buildDailyReportPreset(Date.now());
      await saveTemplate(tpl);
    } catch (e) {
      showError(e);
    }
  };

  const onImportTemplate = async () => {
    try {
      const picked = await pickTextFile(JSON_ACCEPT);
      if (!picked) return; // キャンセルは黙って戻る
      let raw: unknown;
      try {
        raw = JSON.parse(picked.text);
      } catch (e) {
        toast.show(t('settings.templateImportFailed', { reason: errorText(e) }), 'error');
        return;
      }
      const normalized = normalizeTemplate(raw);
      if (!normalized) {
        toast.show(
          t('settings.templateImportFailed', {
            reason: t('settings.templateImportInvalid'),
          }),
          'error',
        );
        return;
      }
      // id が既存と同じなら上書き、無ければ追加（saveTemplate が両対応）。
      await saveTemplate(normalized);
      toast.show(t('settings.templateImported', { name: normalized.name }));
    } catch (e) {
      toast.show(t('settings.templateImportFailed', { reason: errorText(e) }), 'error');
    }
  };

  const onExportTemplate = (tpl: Template) => {
    try {
      downloadTextFile(`${safeFilename(tpl.name)}.json`, JSON.stringify(tpl, null, 2));
    } catch (e) {
      showError(e);
    }
  };

  // ---------- バックアップ ----------

  const onExportBackup = () => {
    try {
      const data: ReplaceAllData = { settings, subjects, groups, templates };
      downloadTextFile(`template-memo-backup-${yyyymmdd()}.json`, buildBackupJson(data));
    } catch (e) {
      showError(e);
    }
  };

  const onPickBackup = async () => {
    try {
      const picked = await pickTextFile(JSON_ACCEPT);
      if (!picked) return;
      const data = parseBackupJson(picked.text); // throw = 日本語 reason
      setConfirm({ kind: 'backupImport', data });
    } catch (e) {
      toast.show(t('settings.backupImportFailed', { reason: errorText(e) }), 'error');
    }
  };

  const onPickWorkspaceImport = async () => {
    try {
      const picked = await pickTextFile(JSON_ACCEPT);
      if (!picked) return;
      const candidates = listImportCandidates(picked.text);
      const first = candidates[0];
      if (!first) throw new Error(t('settings.workspaceImportNoUsers'));
      setWorkspaceImport({
        json: picked.text,
        candidates,
        userId: first.id,
        data: convertWorkspaceBackup(picked.text, first.id),
      });
    } catch (e) {
      toast.show(t('settings.workspaceImportFailed', { reason: errorText(e) }), 'error');
    }
  };

  const selectWorkspaceUser = (userId: string) => {
    if (!workspaceImport) return;
    try {
      setWorkspaceImport({
        ...workspaceImport,
        userId,
        data: convertWorkspaceBackup(workspaceImport.json, userId),
      });
    } catch (e) {
      toast.show(t('settings.workspaceImportFailed', { reason: errorText(e) }), 'error');
    }
  };

  // ---------- 確認ダイアログの実行 ----------

  const runConfirm = async () => {
    const c = confirm;
    if (!c) return;
    if (c.kind === 'workspaceImport') setWorkspaceImportApplying(true);
    setConfirm(null);
    try {
      switch (c.kind) {
        case 'templateDelete':
          await deleteTemplate(c.template.id);
          break;
        case 'groupDelete':
          await deleteGroup(c.group.id);
          break;
        case 'tagDelete':
          await deleteTag(c.tag.id);
          break;
        case 'snippetDelete':
          await deleteSnippet(c.snippet.id);
          break;
        case 'backupImport':
          await replaceAll(c.data);
          toast.show(t('settings.backupImported'));
          break;
        case 'workspaceImport':
          await appendImported(c.data);
          setWorkspaceImport(null);
          toast.show(
            t('settings.workspaceImported', {
              subjects: c.data.subjects.length,
              groups: c.data.groups.length,
              snippets: c.data.snippets.length,
            }),
          );
          break;
        case 'wipe':
          await wipeAll();
          toast.show(t('settings.wiped'));
          break;
      }
    } catch (e) {
      if (c.kind === 'templateDelete') {
        // 最後の 1 件は store が throw する
        toast.show(t('settings.templateDeleteLast'), 'error');
      } else if (c.kind === 'backupImport') {
        toast.show(t('settings.backupImportFailed', { reason: errorText(e) }), 'error');
      } else if (c.kind === 'workspaceImport') {
        toast.show(t('settings.workspaceImportFailed', { reason: errorText(e) }), 'error');
      } else {
        showError(e);
      }
    } finally {
      if (c.kind === 'workspaceImport') setWorkspaceImportApplying(false);
    }
  };

  const confirmProps = (c: ConfirmState): { title: string; body: string } => {
    switch (c.kind) {
      case 'templateDelete':
        return {
          title: t('settings.templateDeleteConfirmTitle'),
          body: t('settings.templateDeleteConfirmBody', { name: c.template.name }),
        };
      case 'groupDelete':
        return {
          title: t('settings.groupDeleteConfirmTitle'),
          body: t('settings.groupDeleteConfirmBody', { name: c.group.name }),
        };
      case 'tagDelete':
        return {
          title: t('settings.tagDeleteConfirmTitle'),
          body: t('settings.tagDeleteConfirmBody', { name: c.tag.name }),
        };
      case 'snippetDelete':
        return {
          title: t('settings.snippetDeleteConfirmTitle'),
          body: t('settings.snippetDeleteConfirmBody', { label: c.snippet.label }),
        };
      case 'backupImport':
        return {
          title: t('settings.backupImportConfirmTitle'),
          body: t('settings.backupImportConfirmBody'),
        };
      case 'workspaceImport':
        return {
          title: t('settings.workspaceImportConfirmTitle'),
          body: t('settings.workspaceImportConfirmBody', {
            subjects: c.data.subjects.length,
            groups: c.data.groups.length,
            snippets: c.data.snippets.length,
          }),
        };
      case 'wipe':
        return {
          title: t('settings.wipeConfirmTitle'),
          body: t('settings.wipeConfirmBody'),
        };
    }
  };

  // ---------- テンプレート編集モード ----------

  if (editing) {
    return <TemplateEditView template={editing} onDone={() => setEditing(null)} />;
  }

  const orderedGroups = sortedGroups(store);
  const orderedTags = [...settings.tags].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );

  return (
    <div className="tm-screen">
      <AppHeader
        left={
          <Button variant="ghost" onClick={onBack}>
            {t('detail.back')}
          </Button>
        }
        center={<strong>{t('settings.title')}</strong>}
      />
      <main className="tm-main">
        {/* 1. テンプレート */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.templates')}</h2>
          {templates.map((tpl) => {
            const isActive = tpl.id === settings.activeTemplateId;
            return (
              <div
                key={tpl.id}
                style={{
                  borderTop: '1px solid var(--border, #e2e8f0)',
                  paddingTop: 8,
                  marginTop: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {tpl.name}
                  </strong>
                  {isActive ? (
                    <span className="tm-subject-meta">{t('settings.templateActive')}</span>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {!isActive ? (
                    <Button onClick={() => void setActiveTemplate(tpl.id).catch(showError)}>
                      {t('settings.templateUse')}
                    </Button>
                  ) : null}
                  <Button onClick={() => setEditing(tpl)}>{t('settings.templateEdit')}</Button>
                  <Button onClick={() => onExportTemplate(tpl)}>
                    {t('settings.templateExport')}
                  </Button>
                  <Button onClick={() => setQrSendTemplate(tpl)}>
                    {t('settings.templateQrSend')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      // 最後の 1 件は開く前に弾く（store も throw で二重に守る）。
                      if (templates.length <= 1) {
                        toast.show(t('settings.templateDeleteLast'), 'error');
                        return;
                      }
                      setConfirm({ kind: 'templateDelete', template: tpl });
                    }}
                  >
                    {t('settings.templateDelete')}
                  </Button>
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12 }}>
            <Button onClick={() => void onAddPreset('round')}>
              {t('settings.templateAddRound')}
            </Button>
            <Button onClick={() => void onAddPreset('daily')}>
              {t('settings.templateAddDaily')}
            </Button>
            <Button onClick={() => void onImportTemplate()}>{t('settings.templateImport')}</Button>
            <Button onClick={() => setQrReceiveOpen(true)}>
              {t('settings.templateQrReceive')}
            </Button>
          </div>
        </section>

        {/* 2. グループ */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.groups')}</h2>
          {orderedGroups.map((g, i) => (
            <GroupRow
              key={g.id}
              group={g}
              isFirst={i === 0}
              isLast={i === orderedGroups.length - 1}
              onDelete={() => setConfirm({ kind: 'groupDelete', group: g })}
              onError={showError}
            />
          ))}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginTop: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                label={t('settings.groupName')}
                value={newGroupName}
                onChange={setNewGroupName}
              />
            </div>
            <Button
              onClick={() => {
                const name = newGroupName.trim();
                if (name === '') return;
                addGroup(name)
                  .then(() => setNewGroupName(''))
                  .catch(showError);
              }}
            >
              {t('settings.groupAdd')}
            </Button>
          </div>
        </section>

        {/* 3. タグ */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.tags')}</h2>
          {orderedTags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              onDelete={() => setConfirm({ kind: 'tagDelete', tag })}
              onError={showError}
            />
          ))}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginTop: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                label={t('settings.tagName')}
                value={newTagName}
                onChange={setNewTagName}
              />
            </div>
            <Button
              onClick={() => {
                const name = newTagName.trim();
                if (name === '') return;
                const maxOrder = Math.max(0, ...settings.tags.map((x) => x.sortOrder));
                saveTag({ id: newId('tag'), name, sortOrder: maxOrder + 1 })
                  .then(() => setNewTagName(''))
                  .catch(showError);
              }}
            >
              {t('settings.tagAdd')}
            </Button>
          </div>
        </section>

        {/* 4. 定型文 */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.snippets')}</h2>
          {settings.snippets.map((sn) => (
            <SnippetRow
              key={sn.id}
              snippet={sn}
              onDelete={() => setConfirm({ kind: 'snippetDelete', snippet: sn })}
              onError={showError}
            />
          ))}
          <div style={{ marginTop: 12 }}>
            <Button
              block
              onClick={() =>
                void saveSnippet({ id: newId('snp'), label: '', body: '' }).catch(showError)
              }
            >
              {t('settings.snippetAdd')}
            </Button>
          </div>
        </section>

        {/* 5. QR出力 */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.qr')}</h2>
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className="field__label" style={{ padding: 0 }}>
              {t('settings.newlineMode')}
            </legend>
            {(
              [
                { mode: 'crlf', label: t('settings.newlineCrlf') },
                { mode: 'lf', label: t('settings.newlineLf') },
              ] as { mode: NewlineMode; label: string }[]
            ).map(({ mode, label }) => (
              <label
                key={mode}
                style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}
              >
                <input
                  type="radio"
                  name={radioName}
                  checked={settings.newlineMode === mode}
                  onChange={() => void updateSettings({ newlineMode: mode }).catch(showError)}
                  style={{ width: 20, height: 20, flex: 'none' }}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </section>

        {/* 6. バックアップ */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.backup')}</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            <Button block onClick={onExportBackup}>
              {t('settings.backupExport')}
            </Button>
            <Button block onClick={() => void onPickBackup()}>
              {t('settings.backupImport')}
            </Button>
            <Button block onClick={() => void onPickWorkspaceImport()}>
              {t('settings.workspaceImport')}
            </Button>
          </div>
        </section>

        {/* 7. 危険な操作 */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.danger')}</h2>
          <Button block variant="danger" onClick={() => setConfirm({ kind: 'wipe' })}>
            {t('settings.wipe')}
          </Button>
        </section>

        {/* 8. このアプリについて */}
        <section className="tm-card">
          <h2 className="tm-card-title">{t('settings.about')}</h2>
          <p style={{ margin: 0 }}>{t('settings.aboutBody')}</p>
          <p className="tm-subject-meta" style={{ margin: '8px 0 0' }}>
            v0.1.0
          </p>
        </section>
      </main>

      {qrSendTemplate ? (
        <TemplateQrSendDialog template={qrSendTemplate} onClose={() => setQrSendTemplate(null)} />
      ) : null}
      {qrReceiveOpen ? (
        <TemplateQrReceiveDialog
          onClose={() => setQrReceiveOpen(false)}
          onSaved={(template) =>
            toast.show(t('settings.templateImported', { name: template.name }))
          }
        />
      ) : null}

      {workspaceImport && !workspaceImportApplying && confirm?.kind !== 'workspaceImport' ? (
        <Modal
          title={t('settings.workspaceImportPreviewTitle')}
          variant="dialog"
          onClose={() => setWorkspaceImport(null)}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setWorkspaceImport(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => setConfirm({ kind: 'workspaceImport', data: workspaceImport.data })}
              >
                {t('settings.workspaceImportApply')}
              </Button>
            </>
          }
        >
          {workspaceImport.candidates.length > 1 ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field__label">{t('settings.workspaceImportUser')}</legend>
              {workspaceImport.candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}
                >
                  <input
                    type="radio"
                    name="workspace-import-user"
                    value={candidate.id}
                    checked={workspaceImport.userId === candidate.id}
                    onChange={() => selectWorkspaceUser(candidate.id)}
                    style={{ width: 20, height: 20, flex: 'none' }}
                  />
                  <span>{candidate.name}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p>
              {t('settings.workspaceImportUser')}: {workspaceImport.candidates[0]?.name}
            </p>
          )}
          <p>
            {t('settings.workspaceImportCounts', {
              subjects: workspaceImport.data.subjects.length,
              groups: workspaceImport.data.groups.length,
              snippets: workspaceImport.data.snippets.length,
            })}
          </p>
          <p className="muted">{t('settings.workspaceImportAppendOnly')}</p>
          {workspaceImport.data.notes.length > 0 ? (
            <ul>
              {workspaceImport.data.notes.map((note) => (
                <li key={note}>
                  {note === 'closingPresetSkipped'
                    ? t('settings.workspaceImportNoteClosingPreset')
                    : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Modal>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          {...confirmProps(confirm)}
          danger={confirm.kind !== 'workspaceImport'}
          confirmLabel={
            confirm.kind === 'workspaceImport'
              ? t('settings.workspaceImportApply')
              : confirm.kind === 'backupImport' || confirm.kind === 'wipe'
                ? t('common.ok')
                : t('common.delete')
          }
          cancelLabel={t('common.cancel')}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
