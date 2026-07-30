// ヘッダーの place 名タップで開く軽量 popup (旧・病棟ピッカー。2026-07-17 患者フラット化で
// 「place = ただの属性」のフィルタ切替に格下げ)。
//   - 一覧からタップ → switchPlace して閉じる (fail-closed: throw で中断 + toast)
//   - 鉛筆 → インラインリネーム / 「+ 新規」→ place 追加 (ws.addPlace)
//   - 末尾に「アーカイブ」ビュー行 (退院/終了患者の一覧・復帰/完全削除の入口)
//   - place の削除は設定画面 (所属患者がいると fail-closed) に置き、ここには出さない。

import { useState } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useToast } from '@snishi/foundation/ui/toast';
import { ARCHIVE_VIEW_ID } from '../../data/store';
import type { AppRuntime } from '../appRuntime';
import { useRegisterOverlay } from '../registries';
import { s } from '../../i18n';
import { UI } from '../../ui-contract';

export function WsPicker({ runtime, onClose }: { runtime: AppRuntime; onClose: () => void }) {
  useRegisterOverlay(onClose);
  const toast = useToast();
  const { store } = runtime;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const activeId = store.storage.getActiveWorkspaceId();
  const places = store.listPlaces();
  const archivedCount = store.listAllPatients().filter((p) => !!p.archivedAt).length;

  async function switchTo(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      // fail-closed: 現ビューの保存に失敗したら switchPlace が throw → 切替中断
      await store.switchPlace(id);
      runtime.bump();
      onClose();
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
      runtime.bump(); // active 改名時のヘッダーラベル同期
    } catch (e) {
      console.error('place rename failed:', e);
      toast.show(s.io.ws.rename.failed, 'error');
    }
  }

  async function commitAdd(): Promise<void> {
    const label = addDraft.trim();
    setAdding(false);
    setAddDraft('');
    if (!label) return;
    if (busy) return;
    setBusy(true);
    try {
      const place = await store.addPlace(label);
      await store.switchPlace(place.placeId);
      runtime.bump();
      onClose();
    } catch (e) {
      console.error('place create failed:', e);
      toast.show(s.io.ws.create.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={s.wsPicker.title}
      titleVariant="sr-only"
      onClose={onClose}
      variant="dialog"
      dataUi={UI.picker.wsDialog}
      closeLabel={s.common.close}
    >
      <div className="pickerList">
        {places.length === 0 ? <p className="muted">{s.io.ws.list.empty}</p> : null}
        {places.map((row) => (
          <div
            key={row.placeId}
            className={`pickerRow${row.placeId === activeId ? ' selected' : ''}`}
          >
            {renamingId === row.placeId ? (
              <input
                className="input pickerRenameInput"
                type="text"
                value={renameDraft}
                autoComplete="off"
                aria-label={s.io.ws.rename.title}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => void commitRename(row.placeId, row.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitRename(row.placeId, row.name);
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
                  disabled={busy || row.placeId === activeId}
                  data-ui={UI.picker.wsRow}
                  onClick={() => void switchTo(row.placeId)}
                >
                  <span className="pickerRowLabel">{row.name || s.io.ws.untitled}</span>
                </button>
                {/* place の改名 (「設定に登録→患者に付ける」型・改名は患者表示へ自動追従)。 */}
                <IconButton
                  label={s.io.ws.rename.title}
                  dataUi={UI.picker.wsRename}
                  onClick={() => {
                    setRenamingId(row.placeId);
                    setRenameDraft(row.name);
                  }}
                >
                  <Icon name="edit" size={16} />
                </IconButton>
              </>
            )}
          </div>
        ))}
        {/* アーカイブ一覧 (退院/終了患者)。 */}
        <div className={`pickerRow${activeId === ARCHIVE_VIEW_ID ? ' selected' : ''}`}>
          <button
            type="button"
            className="pickerRowMain"
            disabled={busy || activeId === ARCHIVE_VIEW_ID}
            data-ui={UI.picker.archiveRow}
            onClick={() => void switchTo(ARCHIVE_VIEW_ID)}
          >
            <span className="pickerRowLabel">{s.archive.viewLabel}</span>
            <span className="pickerRowMeta">{s.archive.count(archivedCount)}</span>
          </button>
        </div>
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
          <button
            type="button"
            className="menu-item pickerAddBtn"
            title={s.io.ws.create.action}
            aria-label={s.io.ws.create.action}
            data-ui={UI.picker.wsAdd}
            onClick={() => setAdding(true)}
          >
            <Icon name="add" size={18} />
            {s.io.ws.create.action}
          </button>
        )}
      </div>
    </Modal>
  );
}
