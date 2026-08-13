// 設定画面 (コピー元: hospital-workspace/rounds/ui/settings/SettingsView.tsx)。
//   タグ管理 / テンプレート (有効切替・編集・プリセット/空テンプレ追加・パッケージQR送受信・削除) /
//   フレーム (一覧・編集・複製・QR送信・削除) / フォーマット (同) / QR出力 (改行) /
//   場所の管理 / バックアップ (JSON 書出・復元) / 巻き戻し / 全削除 /
//   操作ガイド (準備中プレースホルダ)
//
// 剥離: ユーザー管理 / 共有タグ / 研究ログ / AI (回診設定 slot) / 同期。
// 移設: テンプレQR送受信・JSONバックアップ/復元・全削除 (旧 v1 SettingsView から)。

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from '@snishi/foundation/ui/Modal';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { useToast } from '@snishi/foundation/ui/toast';
import type { RestorePoint } from '@snishi/foundation/snapshot/snapshots';
import { fmtTimestamp } from '@snishi/foundation/format/timestamp';
import { TAG_COLORS, type TagColor } from '../../domain/types';
import { normalizePatientArray } from '../../domain/normalize';
import { buildBackupJson, parseBackupJson } from '../../domain/backup';
import type { Format, Frame, TemplateDef } from '../../domain/entities';
import {
  buildTemplatePackage,
  FORMAT_WIRE_KIND,
  FRAME_WIRE_KIND,
  sharePayloadName,
  TEMPLATE_WIRE_KIND,
  type ShareWirePayload,
} from '../../domain/templateWire';
import { buildDailyReportPreset, buildRoundPreset } from '../../domain/presets';
import { newId } from '../../data/constants';
import { REASON } from '../../data/snapshots';
import { useRevision, type AppRuntime } from '../appRuntime';
import { AddTagWidget } from '../TagPicker';
import { BottomActionBar } from '../BottomActionBar';
import { deleteTagAt, renameTagAt, setTagColor } from '../tags';
import { OverlayBinding, useRegisterOverlay } from '../registries';
import { downloadTextFile, pickTextFile } from '../files';
import { ShareQrSendDialog } from '../ShareQrSendDialog';
import { ShareQrReceiveDialog } from '../ShareQrReceiveDialog';
import { TemplateEditView } from '../TemplateEditView';
import { FrameEditView } from '../FrameEditView';
import { FormatEditView } from '../FormatEditView';
import { TemplateBuilderPreview, TemplateBuilderSection } from '../TemplateBuilder';
import type { ParsedBuilderDraft } from '../builderDraft';
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
// タグ管理 (追加 / 改名 / 色の切替 / 削除。初期化ボタンは置かない)。
// 色は見た目ではなく「ラウンド開始で外れるか」(domain/tags.ts)。
// ============================

function TagManagerSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const { store } = runtime;
  const settings = store.getSettings();
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);

  const tags = Array.isArray(settings.tags) ? settings.tags : [];

  // 改名・削除は全対象（他グループ・アーカイブ済みを含む）へ波及させるため await する。
  async function commitRename(idx: number): Promise<void> {
    const next = renameDraft.trim();
    setRenamingIdx(null);
    if (!next || next === tags[idx]?.name) return;
    try {
      if (!(await renameTagAt(store, idx, next))) {
        toast.show(s.settings.tag.name.duplicate, 'error');
        return;
      }
    } catch (e) {
      toast.show(errorText(e, s.toast.saveFailed), 'error');
      return;
    }
    runtime.bump();
  }

  return (
    <div className="card card--pad settingsSection">
      <div className="section-label">{s.settings.title.tags}</div>
      {/* 色 = クリア方針 (青は残る / それ以外は外れる) なので、選ぶ前に意味が読めるようにする。 */}
      <p className="muted settingsHint">{s.settings.tag.hint}</p>
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
                  onBlur={() => void commitRename(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename(idx);
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
                  {/* 色スウォッチ: TAG_COLORS 分の小丸ボタン。タップで setTagColor
                      (= ラウンド開始で外れるかの切替)。選択中は枠強調・aria-label に意味を出す。 */}
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
            void deleteTagAt(store, idx)
              .then(() => runtime.bump())
              .catch((e: unknown) => toast.show(errorText(e, s.toast.saveFailed), 'error'));
          }}
        />
      ) : null}
    </div>
  );
}

// ============================
// 「QRで受け取る」(テンプレート / フレーム / フォーマットの 3 節の見出し右上に置く)。
// 受信ダイアログは TPL/FRM/FMT の 3 種すべてを受理するため、状態と保存の分岐はこの 1 箇所だけに置き、
// 各節はこのボタンを置くだけにする (節ごとに分岐を書き写さない)。
// ============================

function ShareQrReceiveButton({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const { store } = runtime;
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 見出し右上。アイコンのみだと「受け取る」意図が伝わらないので文字ラベルを出す。 */}
      <Button onClick={() => setOpen(true)}>
        <Icon name="scan" size={16} />
        {s.settings.template.qrReceive}
      </Button>

      {open ? <OverlayBinding onClose={() => setOpen(false)} /> : null}
      {open ? (
        <ShareQrReceiveDialog
          existing={{
            templates: store.getTemplateDefs(),
            frames: store.getFrames(),
            formats: store.getFormats(),
          }}
          onSave={async (payload) => {
            if (payload.kind === FRAME_WIRE_KIND) {
              await store.saveFrame(payload.frame);
              return;
            }
            if (payload.kind === FORMAT_WIRE_KIND) {
              await store.saveFormat(payload.format);
              return;
            }
            await store.saveFrame(payload.package.frame);
            for (const format of payload.package.formats) {
              await store.saveFormat(format);
            }
            await store.saveTemplateDef(payload.package.template);
          }}
          onClose={() => setOpen(false)}
          onSaved={(payload) => {
            const kindLabel =
              payload.kind === FRAME_WIRE_KIND
                ? s.templateQr.frame
                : payload.kind === FORMAT_WIRE_KIND
                  ? s.templateQr.format
                  : s.templateQr.templatePackage;
            toast.show(
              s.templateQr.imported(kindLabel, sharePayloadName(payload) || s.common.untitled),
            );
            runtime.bump();
          }}
        />
      ) : null}
    </>
  );
}

/** 節の見出し行 (左=見出し / 右端=節のボタン)。DetailQrDialog と同じ qrCardHead パターン。 */
function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="qrCardHead settingsSectionHead">
      <div className="section-label">{title}</div>
      <span className="qrCardHeadSpacer" />
      {children}
    </div>
  );
}

// ============================
// テンプレート (有効切替 / 編集 / 複製 / プリセット・空テンプレ追加 / QR送受信 / 削除)。
// 編集は TemplateEditView (設定画面のローカル state で切替・ルートは増やさない)。
// 追加は ＋ 1 個に集約し、プリセット (回診 / 日報) と空テンプレはメニューで選ばせる。
// ============================

/** ＋ から開く追加メニュー (プリセット 2 種 + 空テンプレ)。ProjectionFormCard の配置メニューと同じ形。 */
function TemplateAddMenuDialog({
  onSelect,
  onClose,
}: {
  onSelect: (kind: 'round' | 'daily' | 'empty') => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const items: { kind: 'round' | 'daily' | 'empty'; label: string }[] = [
    { kind: 'round', label: s.settings.template.addRound },
    { kind: 'daily', label: s.settings.template.addDaily },
    { kind: 'empty', label: s.settings.template.addEmpty },
  ];
  return (
    <Modal
      title={s.settings.template.add}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <div className="menu-list">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            className="menu-item"
            onClick={() => onSelect(item.kind)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function TemplateSection({
  runtime,
  onEdit,
}: {
  runtime: AppRuntime;
  onEdit: (template: TemplateDef) => void;
}) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const templates = store.getTemplateDefs();
  const activeId = store.getSettings().activeTemplateId;
  const [sendTarget, setSendTarget] = useState<ShareWirePayload | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TemplateDef | null>(null);
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

  async function runDelete(target: TemplateDef): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.deleteTemplateDef(target.id);
      runtime.bump();
    } catch (e) {
      console.error('template delete failed:', e);
      toast.show(errorText(e, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  async function duplicate(templateId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.duplicateTemplateDef(templateId);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addPreset(kind: 'round' | 'daily'): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const preset =
        kind === 'round' ? buildRoundPreset(Date.now()) : buildDailyReportPreset(Date.now());
      await store.saveFrame(preset.frame);
      for (const format of preset.formats) await store.saveFormat(format);
      await store.saveTemplateDef(preset.template);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  function addEmpty(): void {
    // 何も永続化せず編集画面だけを開く (キャンセルで孤児フレームを残さない)。
    // フレームは既存の先頭を既定にする (テンプレートが常に 1 個以上ある = その参照フレームも必ず在る)。
    const frame = store.getFrames()[0];
    if (!frame) {
      toast.show(s.toast.saveFailed, 'error');
      return;
    }
    onEdit({
      id: newId('tpl'),
      name: '',
      frameId: frame.id,
      includeProblems: false,
      includeHandover: false,
      placements: [],
      updatedAt: Date.now(),
    });
  }

  return (
    <div className="card card--pad settingsSection" data-ui={UI.settings.templateSection}>
      <SectionHead title={s.settings.template.section}>
        <ShareQrReceiveButton runtime={runtime} />
      </SectionHead>
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
                <span className="pickerRowLabel">{tpl.name || s.common.untitled}</span>
                <span className="pickerRowMeta">
                  {isActive ? s.settings.template.active : s.settings.template.use}
                </span>
              </button>
              <span className="formatListActions">
                <IconButton label={s.common.edit} onClick={() => onEdit(tpl)}>
                  <Icon name="edit" size={16} />
                </IconButton>
                <IconButton
                  label={s.common.duplicate}
                  disabled={busy}
                  onClick={() => void duplicate(tpl.id)}
                >
                  <Icon name="copy" size={18} />
                </IconButton>
                <IconButton
                  label={s.settings.template.qrSend}
                  onClick={() =>
                    setSendTarget({
                      kind: TEMPLATE_WIRE_KIND,
                      package: buildTemplatePackage(tpl, store.getFrames(), store.getFormats()),
                    })
                  }
                >
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
        <IconButton
          label={s.settings.template.add}
          disabled={busy}
          onClick={() => setAddMenuOpen(true)}
        >
          <Icon name="add" size={16} />
        </IconButton>
      </div>

      {sendTarget ? <OverlayBinding onClose={() => setSendTarget(null)} /> : null}
      {sendTarget ? (
        <ShareQrSendDialog payload={sendTarget} onClose={() => setSendTarget(null)} />
      ) : null}

      {addMenuOpen ? (
        <TemplateAddMenuDialog
          onSelect={(kind) => {
            setAddMenuOpen(false);
            if (kind === 'empty') addEmpty();
            else void addPreset(kind);
          }}
          onClose={() => setAddMenuOpen(false)}
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

function FrameSettingsSection({
  runtime,
  onEdit,
}: {
  runtime: AppRuntime;
  onEdit: (frame: Frame) => void;
}) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const frames = store.getFrames();
  const templates = store.getTemplateDefs();
  const [deleteTarget, setDeleteTarget] = useState<Frame | null>(null);
  // payload を state に保持する (毎レンダー新オブジェクトだと送信中の再エンコードで batchId が割れる)。
  const [sendPayload, setSendPayload] = useState<ShareWirePayload | null>(null);
  const [busy, setBusy] = useState(false);

  function addFrame(): void {
    onEdit({
      id: newId('frm'),
      name: '',
      sections: [{ id: newId('sec'), title: '', freeText: true }],
    });
  }

  async function duplicate(frameId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.duplicateFrame(frameId);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(frame: Frame): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.deleteFrame(frame.id);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="card card--pad settingsSection" data-ui={UI.settings.frameSection}>
      <SectionHead title={s.settings.frame.section}>
        <ShareQrReceiveButton runtime={runtime} />
      </SectionHead>
      {frames.map((frame) => {
        const usageCount = templates.filter((template) => template.frameId === frame.id).length;
        return (
          <div key={frame.id} className="formatListRow">
            <span className="pickerRowMain">
              <span className="pickerRowLabel">{frame.name || s.common.untitled}</span>
              <span className="pickerRowMeta">{s.settings.frame.usage(usageCount)}</span>
            </span>
            <span className="formatListActions">
              <IconButton label={s.common.edit} onClick={() => onEdit(frame)}>
                <Icon name="edit" size={16} />
              </IconButton>
              <IconButton
                label={s.common.duplicate}
                disabled={busy}
                onClick={() => void duplicate(frame.id)}
              >
                <Icon name="copy" size={18} />
              </IconButton>
              <IconButton
                label={s.settings.template.qrSend}
                onClick={() => setSendPayload({ kind: FRAME_WIRE_KIND, frame })}
              >
                <Icon name="qr" size={16} />
              </IconButton>
              <IconButton
                label={s.common.delete}
                disabled={busy}
                onClick={() => setDeleteTarget(frame)}
              >
                <Icon name="delete" size={16} />
              </IconButton>
            </span>
          </div>
        );
      })}
      <div className="settingsRowActions">
        <IconButton label={s.settings.frame.add} disabled={busy} onClick={addFrame}>
          <Icon name="add" size={16} />
        </IconButton>
      </div>

      {sendPayload ? <OverlayBinding onClose={() => setSendPayload(null)} /> : null}
      {sendPayload ? (
        <ShareQrSendDialog payload={sendPayload} onClose={() => setSendPayload(null)} />
      ) : null}

      {deleteTarget ? <OverlayBinding onClose={() => setDeleteTarget(null)} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={s.settings.frame.deleteConfirmTitle}
          body={s.settings.frame.deleteConfirmBody(deleteTarget.name)}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void runDelete(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

function FormatSettingsSection({
  runtime,
  onEdit,
}: {
  runtime: AppRuntime;
  onEdit: (format: Format) => void;
}) {
  const toast = useToast();
  useRevision(runtime);
  const { store } = runtime;
  const formats = store.getFormats();
  const templates = store.getTemplateDefs();
  const [deleteTarget, setDeleteTarget] = useState<Format | null>(null);
  const [sendPayload, setSendPayload] = useState<ShareWirePayload | null>(null);
  const [busy, setBusy] = useState(false);

  function addFormat(): void {
    onEdit({
      id: newId('fmt'),
      name: '',
      joiner: '\n',
      labelSep: '：',
      titleWrap: '',
      items: [{ id: newId('itm'), label: s.tpl.items, kind: 'text' }],
    });
  }

  async function duplicate(formatId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.duplicateFormat(formatId);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(format: Format): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await store.deleteFormat(format.id);
      runtime.bump();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="card card--pad settingsSection" data-ui={UI.settings.formatSection}>
      <SectionHead title={s.settings.format.section}>
        <ShareQrReceiveButton runtime={runtime} />
      </SectionHead>
      {formats.map((format) => {
        const usageCount = templates.filter((template) =>
          template.placements.some((placement) => placement.formatId === format.id),
        ).length;
        return (
          <div key={format.id} className="formatListRow">
            <span className="pickerRowMain">
              <span className="pickerRowLabel">{format.name || s.common.untitled}</span>
              <span className="pickerRowMeta">{s.settings.format.usage(usageCount)}</span>
            </span>
            <span className="formatListActions">
              <IconButton label={s.common.edit} onClick={() => onEdit(format)}>
                <Icon name="edit" size={16} />
              </IconButton>
              <IconButton
                label={s.common.duplicate}
                disabled={busy}
                onClick={() => void duplicate(format.id)}
              >
                <Icon name="copy" size={18} />
              </IconButton>
              <IconButton
                label={s.settings.template.qrSend}
                onClick={() => setSendPayload({ kind: FORMAT_WIRE_KIND, format })}
              >
                <Icon name="qr" size={16} />
              </IconButton>
              <IconButton
                label={s.common.delete}
                disabled={busy}
                onClick={() => setDeleteTarget(format)}
              >
                <Icon name="delete" size={16} />
              </IconButton>
            </span>
          </div>
        );
      })}
      <div className="settingsRowActions">
        <IconButton label={s.settings.format.add} disabled={busy} onClick={addFormat}>
          <Icon name="add" size={16} />
        </IconButton>
      </div>

      {sendPayload ? <OverlayBinding onClose={() => setSendPayload(null)} /> : null}
      {sendPayload ? (
        <ShareQrSendDialog payload={sendPayload} onClose={() => setSendPayload(null)} />
      ) : null}

      {deleteTarget ? <OverlayBinding onClose={() => setDeleteTarget(null)} /> : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={s.settings.format.deleteConfirmTitle}
          body={s.settings.format.deleteConfirmBody(deleteTarget.name)}
          confirmLabel={s.common.delete}
          cancelLabel={s.common.cancel}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void runDelete(deleteTarget)}
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
  const [editing, setEditing] = useState<
    | { kind: 'template'; value: TemplateDef }
    | { kind: 'frame'; value: Frame }
    | { kind: 'format'; value: Format }
    | { kind: 'builder'; value: ParsedBuilderDraft }
    | null
  >(null);
  if (editing) {
    if (editing.kind === 'template') {
      return (
        <TemplateEditView
          runtime={runtime}
          template={editing.value}
          onDone={() => setEditing(null)}
        />
      );
    }
    if (editing.kind === 'frame') {
      return (
        <FrameEditView runtime={runtime} frame={editing.value} onDone={() => setEditing(null)} />
      );
    }
    if (editing.kind === 'builder') {
      return (
        <TemplateBuilderPreview
          runtime={runtime}
          candidate={editing.value.candidate}
          warnings={editing.value.warnings}
          onDone={() => setEditing(null)}
        />
      );
    }
    return (
      <FormatEditView runtime={runtime} format={editing.value} onDone={() => setEditing(null)} />
    );
  }
  // 設定入口はヘッダー右上の 1 つだけ。画面タイトルの見出しは出さない (内容を見れば分かる)。
  return (
    <section aria-label={s.header.settings} className="settingsView" data-ui={UI.settings.view}>
      <TagManagerSection runtime={runtime} />
      <TemplateBuilderSection onPreview={(value) => setEditing({ kind: 'builder', value })} />
      <TemplateSection
        runtime={runtime}
        onEdit={(value) => setEditing({ kind: 'template', value })}
      />
      <FrameSettingsSection
        runtime={runtime}
        onEdit={(value) => setEditing({ kind: 'frame', value })}
      />
      <FormatSettingsSection
        runtime={runtime}
        onEdit={(value) => setEditing({ kind: 'format', value })}
      />
      <QrOutputSection runtime={runtime} />
      <PlaceSection runtime={runtime} />
      <DataSection runtime={runtime} />
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
