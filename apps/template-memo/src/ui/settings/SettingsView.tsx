// 設定画面 (コピー元: hospital-workspace/rounds/ui/settings/SettingsView.tsx)。
//   タグ管理 / テンプレート (有効切替・QR送受信・削除) / QR出力 (改行) /
//   場所の管理 / バックアップ (JSON 書出・復元) / ワークスペース移行 / 巻き戻し / 全削除 /
//   操作ガイド (準備中プレースホルダ)
//
// 剥離: ユーザー管理 / 共有タグ / 研究ログ / AI (回診設定 slot) / 同期。
// 移設: テンプレQR送受信・JSONバックアップ/復元・ワークスペース移行・全削除 (旧 v1 SettingsView から)。

import { useEffect, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import type { RestorePoint } from '@snishi/foundation/snapshot/snapshots';
import { fmtTimestamp } from '@snishi/foundation/format/timestamp';
import { TAG_COLORS, type TagColor } from '../../domain/types';
import { normalizePatientArray } from '../../domain/normalize';
import { buildBackupJson, parseBackupJson } from '../../domain/backup';
import {
  convertWorkspaceBackup,
  listImportCandidates,
  type WorkspaceImportCandidate,
  type WorkspaceImportData,
} from '../../domain/importWorkspace';
import { buildDailyReportPreset, buildRoundPreset, type Template } from '../../domain/template';
import { newId } from '../../data/constants';
import { REASON } from '../../data/snapshots';
import { useRevision, type AppRuntime } from '../appRuntime';
import { AddTagWidget } from '../TagPicker';
import { BottomActionBar } from '../BottomActionBar';
import { deleteTagAt, renameTagAt, setTagColor } from '../tags';
import { OverlayBinding, useRegisterOverlay } from '../registries';
import { downloadTextFile, pickTextFile } from '../files';
import { TemplateQrSendDialog } from '../TemplateQrSendDialog';
import { TemplateQrReceiveDialog } from '../TemplateQrReceiveDialog';
import { TemplateEditView } from '../TemplateEditView';
import { errorText, s } from '../../i18n';
import { UI } from '../../ui-contract';

// ============================
// 小物
// ============================

function timestampSuffix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}_${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function envPrefix(): string {
  return document.documentElement.dataset.env === 'test' ? 'test_' : '';
}

// ============================
// タグ管理 (追加 / 改名 / 削除。初期化ボタンは置かない)
// ============================

function TagManagerSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const { store } = runtime;
  const settings = store.getSettings();
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);

  const tags = Array.isArray(settings.tags) ? settings.tags : [];

  function commitRename(idx: number): void {
    const next = renameDraft.trim();
    setRenamingIdx(null);
    if (!next || next === tags[idx]?.name) return;
    if (!renameTagAt(store, idx, next)) {
      toast.show(s.settings.tag.name.duplicate, 'error');
      return;
    }
    runtime.bump();
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.title.tags}</div>
      <div className="tagSettingList" data-ui={UI.settings.tagList}>
        {tags.map((tagDef, idx) => {
          const name = tagDef.name;
          return (
            <span key={`${name}-${idx}`} className="tagSettingChip" data-ui={UI.settings.tagRow}>
              {renamingIdx === idx ? (
                <input
                  className="input tagSettingInput"
                  type="text"
                  value={renameDraft}
                  placeholder={s.settings.tag.placeholder}
                  autoComplete="off"
                  aria-label={s.common.edit}
                  // 明示的な編集タップ後の単一入力 (中央ルールの明示経路)
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(idx);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingIdx(null);
                    }
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="tagSettingChipLabel"
                    title={s.common.edit}
                    onClick={() => {
                      setRenamingIdx(idx);
                      setRenameDraft(name);
                    }}
                  >
                    {name || s.settings.tagGroup.name.empty}
                  </button>
                  {/* 色スウォッチ: TAG_COLORS 分の小丸ボタン。タップで setTagColor。選択中は枠強調 */}
                  {(TAG_COLORS as readonly TagColor[]).map((color) => {
                    const isSelected = tagDef.color === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        className={`tagColorSwatch tagColorSwatch--${color}${isSelected ? ' selected' : ''}`}
                        aria-label={s.settings.tag.color[color]}
                        aria-pressed={isSelected}
                        title={s.settings.tag.color[color]}
                        data-ui={UI.settings.tagColor}
                        onClick={() => {
                          setTagColor(store, idx, color);
                          runtime.bump();
                        }}
                      />
                    );
                  })}
                  <button
                    type="button"
                    className="tagSettingDel"
                    title={s.common.delete}
                    aria-label={s.settings.tag.delete.aria(name || s.settings.tagGroup.name.empty)}
                    data-ui={UI.settings.tagDelete}
                    onClick={() => setDeleteIdx(idx)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </>
              )}
            </span>
          );
        })}
        <AddTagWidget store={store} onAdded={() => runtime.bump()} />
      </div>

      {deleteIdx != null ? <OverlayBinding onClose={() => setDeleteIdx(null)} /> : null}
      {deleteIdx != null ? (
        <ConfirmDialog
          title={s.common.delete}
          body={s.settings.tag.delete.confirm(tags[deleteIdx]?.name ?? '')}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteIdx(null)}
          onConfirm={() => {
            const idx = deleteIdx;
            setDeleteIdx(null);
            deleteTagAt(store, idx);
            runtime.bump();
          }}
        />
      ) : null}
    </div>
  );
}

// ============================
// テンプレート (有効切替 / QR送受信 / 削除)。編集 UI は持たない (QR/プリセットで受け渡し)。
// ============================

function TemplateSection({
  runtime,
  onEdit,
}: {
  runtime: AppRuntime;
  onEdit: (template: Template) => void;
}) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const templates = store.getTemplates();
  const activeId = store.getSettings().activeTemplateId;
  const [sendTarget, setSendTarget] = useState<Template | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);

  async function activate(templateId: string): Promise<void> {
    if (busy || templateId === activeId) return;
    setBusy(true);
    try {
      await store.setActiveTemplate(templateId);
      runtime.bump();
    } catch (e) {
      console.error('template activate failed:', e);
      toast.show(errorText(e, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(target: Template): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.deleteTemplate(target.id);
      runtime.bump();
    } catch (e) {
      console.error('template delete failed:', e);
      toast.show(errorText(e, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  async function addPreset(kind: 'round' | 'daily'): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const template =
        kind === 'round' ? buildRoundPreset(Date.now()) : buildDailyReportPreset(Date.now());
      await store.saveTemplate(template);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  function addEmpty(): void {
    const sectionId = newId('sec');
    onEdit({
      id: newId('tpl'),
      name: '',
      includeProblems: false,
      includeHandover: false,
      memoSectionId: sectionId,
      sections: [
        {
          id: sectionId,
          title: '',
          keepWhenEmpty: false,
          freeText: true,
          groups: [],
        },
      ],
      updatedAt: Date.now(),
    });
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.template.section}</div>
      <div>
        {templates.map((tpl) => {
          const isActive = tpl.id === activeId;
          return (
            <div key={tpl.id} className={`formatListRow${isActive ? ' activeRow' : ''}`}>
              <button
                type="button"
                className="pickerRowMain"
                disabled={busy || isActive}
                onClick={() => void activate(tpl.id)}
              >
                <span className="pickerRowLabel">{tpl.name}</span>
                <span className="pickerRowMeta">
                  {isActive ? s.settings.template.active : s.settings.template.use}
                </span>
              </button>
              <span className="formatListActions">
                <IconButton label={s.common.edit} onClick={() => onEdit(tpl)}>
                  <Icon name="edit" size={16} />
                </IconButton>
                <IconButton label={s.settings.template.qrSend} onClick={() => setSendTarget(tpl)}>
                  <Icon name="qr" size={16} />
                </IconButton>
                {templates.length > 1 ? (
                  <IconButton label={s.common.delete} onClick={() => setDeleteTarget(tpl)}>
                    <Icon name="delete" size={16} />
                  </IconButton>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="settingsRowActions">
        <Button onClick={() => setReceiveOpen(true)}>{s.settings.template.qrReceive}</Button>
        <Button disabled={busy} onClick={() => void addPreset('round')}>
          {s.settings.template.addRound}
        </Button>
        <Button disabled={busy} onClick={() => void addPreset('daily')}>
          {s.settings.template.addDaily}
        </Button>
        <Button disabled={busy} onClick={addEmpty}>
          {s.settings.template.addEmpty}
        </Button>
      </div>

      {sendTarget ? <OverlayBinding onClose={() => setSendTarget(null)} /> : null}
      {sendTarget ? (
        <TemplateQrSendDialog template={sendTarget} onClose={() => setSendTarget(null)} />
      ) : null}

      {receiveOpen ? <OverlayBinding onClose={() => setReceiveOpen(false)} /> : null}
      {receiveOpen ? (
        <TemplateQrReceiveDialog
          templates={templates}
          onSave={(tpl) => store.saveTemplate(tpl)}
          onClose={() => setReceiveOpen(false)}
          onSaved={(tpl) => {
            toast.show(s.settings.template.imported(tpl.name));
            runtime.bump();
          }}
        />
      ) : null}

      {deleteTarget ? <OverlayBinding onClose={() => setDeleteTarget(null)} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={s.settings.template.deleteConfirmTitle}
          body={s.settings.template.deleteConfirmBody(deleteTarget.name)}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (target) void runDelete(target);
          }}
        />
      ) : null}
    </div>
  );
}

// ============================
// QR 出力 (改行モード)。
// ============================

function QrOutputSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const mode = store.getSettings().newlineMode;

  function setMode(next: 'crlf' | 'lf'): void {
    const settings = store.getSettings();
    settings.newlineMode = next;
    void store
      .saveSettings()
      .then(() => runtime.bump())
      .catch((e) => {
        console.error('newline mode save failed:', e);
        toast.show(errorText(e, s.toast.saveFailed), 'error');
      });
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.qrOutput.section}</div>
      <p className="muted settingsHint">{s.settings.qrOutput.newlineMode}</p>
      <label className="settingsRadioRow">
        <input
          type="radio"
          name="tm-newline-mode"
          checked={mode === 'crlf'}
          onChange={() => setMode('crlf')}
        />
        {s.settings.qrOutput.newlineCrlf}
      </label>
      <label className="settingsRadioRow">
        <input
          type="radio"
          name="tm-newline-mode"
          checked={mode === 'lf'}
          onChange={() => setMode('lf')}
        />
        {s.settings.qrOutput.newlineLf}
      </label>
    </div>
  );
}

// ============================
// place (場所/グループの区分。一覧・切替・改名・削除・追加)。
// place はただの属性。削除は所属患者が居ると fail-closed。
// ============================

function PlaceSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ placeId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const activeId = store.storage.getActiveWorkspaceId();
  const places = store.listPlaces();
  const patientCountOf = (placeId: string) =>
    store.listAllPatients().filter((p) => p.placeId === placeId && !p.archivedAt).length;

  async function switchTo(id: string): Promise<void> {
    if (busy || id === activeId) return;
    setBusy(true);
    try {
      await store.switchPlace(id); // fail-closed (保存できなければ切替しない)
      runtime.bump();
    } catch (e) {
      console.error('place switch failed:', e);
      toast.show(s.io.ws.switch.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(placeId: string, current: string): Promise<void> {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === current) return;
    try {
      await store.renamePlace(placeId, next);
      runtime.bump(); // active 改名時のヘッダーラベル同期 (患者側表示は placeId 参照で自動追従)
    } catch (e) {
      console.error('place rename failed:', e);
      toast.show(s.io.ws.rename.failed, 'error');
    }
  }

  async function commitAdd(): Promise<void> {
    const label = addDraft.trim();
    setAdding(false);
    setAddDraft('');
    if (!label || busy) return;
    setBusy(true);
    try {
      await store.addPlace(label);
      runtime.bump();
    } catch (e) {
      console.error('place create failed:', e);
      toast.show(s.io.ws.create.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  // 削除: 所属患者 (アーカイブ済み含む) が居る place は store 側が fail-closed で弾く。
  async function runDelete(target: { placeId: string; name: string }): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.deletePlace(target.placeId);
      runtime.bump();
    } catch (e) {
      console.error('place delete failed:', e);
      toast.show(e instanceof Error ? e.message : s.io.ws.delete.failed, 'error');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.title.workspaces}</div>
      <p className="muted settingsHint">{s.settings.ward.hint}</p>
      <div data-ui={UI.settings.wardList}>
        {places.length === 0 ? (
          <p className="muted settingsListEmpty">{s.io.ws.list.empty}</p>
        ) : null}
        {places.map((w) => {
          const isCurrent = w.placeId === activeId;
          return (
            <div
              key={w.placeId}
              className={`formatListRow${isCurrent ? ' activeRow' : ''}`}
              data-ui={UI.settings.wardRow}
            >
              {renamingId === w.placeId ? (
                <input
                  className="input pickerRenameInput"
                  type="text"
                  value={renameDraft}
                  autoComplete="off"
                  aria-label={s.io.ws.rename.title}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename(w.placeId, w.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename(w.placeId, w.name);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="pickerRowMain"
                    disabled={busy || isCurrent}
                    onClick={() => void switchTo(w.placeId)}
                  >
                    <span className="pickerRowLabel">{w.name || s.io.ws.untitled}</span>
                    <span className="pickerRowMeta">
                      {s.settings.ward.patientCount(patientCountOf(w.placeId))}
                      {isCurrent ? ` ・ ${s.settings.ward.current}` : ''}
                    </span>
                  </button>
                  <span className="formatListActions">
                    <IconButton
                      label={s.io.ws.rename.title}
                      dataUi={UI.settings.wardRename}
                      onClick={() => {
                        setRenamingId(w.placeId);
                        setRenameDraft(w.name);
                      }}
                    >
                      <Icon name="edit" size={16} />
                    </IconButton>
                    {/* active place は削除不可。所属患者が居る place は store 側が fail-closed で弾く。 */}
                    {!isCurrent ? (
                      <IconButton
                        label={s.common.delete}
                        dataUi={UI.settings.wardDelete}
                        onClick={() => setDeleteTarget({ placeId: w.placeId, name: w.name })}
                      >
                        <Icon name="delete" size={16} />
                      </IconButton>
                    ) : null}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="settingsRowActions">
        {adding ? (
          <input
            className="input pickerAddInput"
            type="text"
            value={addDraft}
            placeholder={s.io.ws.create.placeholder}
            autoComplete="off"
            aria-label={s.io.ws.create.action}
            autoFocus
            onChange={(e) => setAddDraft(e.target.value)}
            onBlur={() => void commitAdd()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitAdd();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setAdding(false);
                setAddDraft('');
              }
            }}
          />
        ) : (
          <Button dataUi={UI.settings.wardAdd} onClick={() => setAdding(true)}>
            {s.io.ws.create.action}
          </Button>
        )}
      </div>

      {deleteTarget ? <OverlayBinding onClose={() => setDeleteTarget(null)} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={s.common.delete}
          body={s.io.ws.delete.confirm(deleteTarget.name || s.io.ws.untitled)}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            if (target) void runDelete(target);
          }}
        />
      ) : null}
    </div>
  );
}

// ============================
// バックアップ (JSON 書き出し / 復元) + 全削除。
// ============================

function DataSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const { store } = runtime;
  const [importConfirm, setImportConfirm] = useState<{ json: string } | null>(null);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  function exportBackup(): void {
    try {
      const json = buildBackupJson(store.exportData());
      downloadTextFile(`${envPrefix()}template_memo_${timestampSuffix()}.json`, json);
      toast.show(s.export.saved);
    } catch (e) {
      console.error('backup export failed:', e);
      toast.show(s.export.failed, 'error');
    }
  }

  async function pickBackup(): Promise<void> {
    try {
      const picked = await pickTextFile('.json,application/json');
      if (!picked) return;
      setImportConfirm({ json: picked.text });
    } catch (e) {
      console.error('backup pick failed:', e);
      toast.show(s.settings.backup.importFailed(errorText(e)), 'error');
    }
  }

  async function runImport(json: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const data = parseBackupJson(json);
      await store.replaceAll(data);
      runtime.bump();
      toast.show(s.settings.backup.imported);
    } catch (e) {
      console.error('backup import failed:', e);
      toast.show(s.settings.backup.importFailed(errorText(e)), 'error');
    } finally {
      setBusy(false);
      setImportConfirm(null);
    }
  }

  async function runWipe(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.wipeAll();
      runtime.bump();
      toast.show(s.settings.danger.wiped);
    } catch (e) {
      console.error('wipe failed:', e);
      toast.show(errorText(e, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
      setWipeConfirm(false);
    }
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.backup.section}</div>
      <div className="settingsRowActions">
        <Button onClick={exportBackup}>{s.settings.backup.export}</Button>
        <Button onClick={() => void pickBackup()}>{s.settings.backup.import}</Button>
      </div>
      <div className="section-label">{s.settings.danger.section}</div>
      <div className="settingsRowActions">
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={() => setWipeConfirm(true)}
        >
          {s.settings.danger.wipe}
        </button>
      </div>

      {importConfirm ? <OverlayBinding onClose={() => setImportConfirm(null)} /> : null}
      {importConfirm ? (
        <ConfirmDialog
          title={s.settings.backup.importConfirmTitle}
          body={s.settings.backup.importConfirmBody}
          confirmLabel={s.settings.backup.import}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setImportConfirm(null)}
          onConfirm={() => {
            const target = importConfirm;
            setImportConfirm(null);
            if (target) void runImport(target.json);
          }}
        />
      ) : null}

      {wipeConfirm ? <OverlayBinding onClose={() => setWipeConfirm(false)} /> : null}
      {wipeConfirm ? (
        <ConfirmDialog
          title={s.settings.danger.wipeConfirmTitle}
          body={s.settings.danger.wipeConfirmBody}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setWipeConfirm(false)}
          onConfirm={() => void runWipe()}
        />
      ) : null}
    </div>
  );
}

// ============================
// 旧 hospital-workspace からの単発移行 (追記のみ・置換しない)。
// ============================

function WorkspaceImportDialog({
  json,
  candidates,
  runtime,
  onClose,
}: {
  json: string;
  candidates: WorkspaceImportCandidate[];
  runtime: AppRuntime;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const toast = useToast();
  const { store } = runtime;
  const [userId, setUserId] = useState(candidates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  let data: WorkspaceImportData | null = null;
  let convertError: string | null = null;
  try {
    data = userId ? convertWorkspaceBackup(json, userId) : null;
  } catch (e) {
    convertError = errorText(e);
  }

  async function apply(): Promise<void> {
    if (!data || busy) return;
    setBusy(true);
    try {
      const counts = { subjects: data.patients.length, groups: data.places.length };
      await store.appendImported(data);
      runtime.bump();
      toast.show(s.settings.workspaceImport.imported(counts.subjects, counts.groups));
      onClose();
    } catch (e) {
      console.error('workspace import failed:', e);
      toast.show(s.settings.workspaceImport.failed(errorText(e)), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={s.settings.workspaceImport.previewTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <div className="settingsField">
        <span className="section-label">{s.settings.workspaceImport.user}</span>
        <select
          className="input"
          value={userId}
          aria-label={s.settings.workspaceImport.user}
          onChange={(e) => setUserId(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {convertError ? <p className="dangerText">{convertError}</p> : null}
      {data ? (
        <>
          <p>{s.settings.workspaceImport.counts(data.patients.length, data.places.length)}</p>
          <p className="muted">{s.settings.workspaceImport.appendOnly}</p>
          {data.notes.includes('closingPresetSkipped') ? (
            <p className="muted">{s.settings.workspaceImport.noteClosingPreset}</p>
          ) : null}
          <div className="settingsRowActions">
            <Button variant="primary" disabled={busy} onClick={() => void apply()}>
              {s.settings.workspaceImport.apply}
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function WorkspaceImportSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<{
    json: string;
    candidates: WorkspaceImportCandidate[];
  } | null>(null);

  async function pick(): Promise<void> {
    try {
      const picked = await pickTextFile('.json,application/json');
      if (!picked) return;
      const candidates = listImportCandidates(picked.text);
      if (candidates.length === 0) {
        toast.show(s.settings.workspaceImport.noUsers, 'error');
        return;
      }
      setDialog({ json: picked.text, candidates });
    } catch (e) {
      console.error('workspace import pick failed:', e);
      toast.show(s.settings.workspaceImport.failed(errorText(e)), 'error');
    }
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.workspaceImport.section}</div>
      <div className="settingsRowActions">
        <Button onClick={() => void pick()}>{s.settings.workspaceImport.pick}</Button>
      </div>
      {dialog ? (
        <WorkspaceImportDialog
          json={dialog.json}
          candidates={dialog.candidates}
          runtime={runtime}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

// ============================
// 巻き戻し (スナップショット復元)
// ============================

// REASON → 表示文言。未知 reason は undefined (行の理由表示を省く)。
const RESTORE_REASON_LABEL: Record<string, string> = {
  [REASON.CLEAR]: s.settings.restore.reason.clear,
  [REASON.MOVE]: s.settings.restore.reason.move,
  [REASON.PATIENT_DELETE]: s.settings.restore.reason.patientDelete,
  [REASON.DELETE]: s.settings.restore.reason.delete,
  [REASON.IMPORT]: s.settings.restore.reason.import,
  [REASON.NAV]: s.settings.restore.reason.nav,
  [REASON.RESTORE_UNDO]: s.settings.restore.reason.undo,
};

function RestoreSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const revision = useRevision(runtime);
  const { store } = runtime;
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [pendingRestore, setPendingRestore] = useState<RestorePoint | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const activeId = store.storage.getActiveWorkspaceId();
    // 現ビュー (place) のスナップショットだけを出す。復元は「現ビューの作業状態へ戻す」
    // (復元前に restore_undo を自動で撮る)。患者の復帰はアーカイブの「戻す」が正で、
    // スナップショットはラウンド開始クリア等の作業状態 undo 用。
    void runtime.snapshots.list().then((list) => {
      if (alive) setPoints(list.filter((snap) => snap.scopeId === activeId));
    });
    return () => {
      alive = false;
    };
  }, [runtime, store, revision]);

  async function runRestore(point: RestorePoint): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const state = store.getAppState();
      const res = await runtime.snapshots.restore(
        point.id,
        { title: state.title, patients: state.patients },
        async (data) => {
          // fail-closed: 保存できなければ live を戻して throw (restore は ok:false を返す)
          const before = store.getAppState().patients;
          store.setAppState({
            ...store.getAppState(),
            patients: normalizePatientArray(data.patients),
          });
          try {
            await store.persistActiveOrThrow();
          } catch (e) {
            store.setAppState({ ...store.getAppState(), patients: before });
            throw e;
          }
        },
      );
      if (!res.ok) {
        toast.show(s.settings.restore.failed, 'error');
        runtime.bump();
        return;
      }
      runtime.bump();
    } catch (e) {
      console.error('restore failed:', e);
      toast.show(s.settings.restore.failed, 'error');
    } finally {
      setBusy(false);
      setPendingRestore(null);
    }
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.restore.section}</div>
      <p className="muted settingsHint">{s.settings.restore.hint}</p>
      <div data-ui={UI.settings.restoreList}>
        {points !== null && points.length === 0 ? (
          <p className="muted settingsListEmpty">{s.settings.restore.empty}</p>
        ) : null}
        {(points ?? []).map((p) => {
          const reasonLabel = RESTORE_REASON_LABEL[p.reason];
          const count = parseInt(p.label || '0', 10) || 0;
          return (
            <div key={p.id} className="formatListRow" data-ui={UI.settings.restoreRow}>
              <span className="formatListName">
                {fmtTimestamp(p.t)}
                <span className="muted restoreMeta">
                  {reasonLabel ? `${reasonLabel} ・ ` : ''}
                  {s.settings.restore.count(count)}
                </span>
              </span>
              <span className="formatListActions">
                <Button
                  disabled={busy}
                  dataUi={UI.settings.restoreAction}
                  onClick={() => setPendingRestore(p)}
                >
                  {s.settings.restore.action}
                </Button>
                <IconButton
                  label={s.common.delete}
                  dataUi={UI.settings.restoreDelete}
                  onClick={() => {
                    void runtime.snapshots.deleteOne(p.id).then(() => runtime.bump());
                  }}
                >
                  <Icon name="delete" size={16} />
                </IconButton>
              </span>
            </div>
          );
        })}
      </div>

      {pendingRestore ? <OverlayBinding onClose={() => setPendingRestore(null)} /> : null}
      {pendingRestore ? (
        <ConfirmDialog
          title={s.settings.restore.section}
          body={s.settings.restore.confirm}
          confirmLabel={s.settings.restore.action}
          cancelLabel={s.common.cancel}
          onCancel={() => setPendingRestore(null)}
          onConfirm={() => {
            const target = pendingRestore;
            setPendingRestore(null);
            if (target) void runRestore(target);
          }}
        />
      ) : null}
    </div>
  );
}

// ============================
// 本体
// ============================

export function SettingsView({
  runtime,
  onNavigateHome,
}: {
  runtime: AppRuntime;
  onNavigateHome?: () => void;
}) {
  useRevision(runtime);
  const [editing, setEditing] = useState<Template | null>(null);
  if (editing) {
    return (
      <TemplateEditView runtime={runtime} template={editing} onDone={() => setEditing(null)} />
    );
  }
  // 設定入口はヘッダー右上の 1 つだけ。画面タイトルの見出しは出さない (内容を見れば分かる)。
  return (
    <section aria-label={s.header.settings} className="settingsView" data-ui={UI.settings.view}>
      <TagManagerSection runtime={runtime} />
      <TemplateSection runtime={runtime} onEdit={setEditing} />
      <QrOutputSection runtime={runtime} />
      <PlaceSection runtime={runtime} />
      <DataSection runtime={runtime} />
      <WorkspaceImportSection runtime={runtime} />
      <RestoreSection runtime={runtime} />
      <div className="card card--pad settingsSection">
        <div className="section-label">{s.settings.guide.section}</div>
        <p className="muted">{s.settings.guide.pending}</p>
      </div>

      {/* 下部固定バー: [ホーム] のみ。 */}
      {onNavigateHome ? (
        <BottomActionBar
          dataUi={UI.settings.actionBar}
          home={{ label: s.header.home, dataUi: UI.settings.homeBottom, onClick: onNavigateHome }}
        />
      ) : null}
    </section>
  );
}
