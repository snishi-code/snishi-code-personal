/*
 * 旧 hospital-workspace からの単発データ移行 UI (追記のみ・置換しない)。
 *
 * 一時機能。設定画面へは import 1 行 + JSX 1 行だけで刺さっており、Modal /
 * useRegisterOverlay もこの機能専用なのでここへ閉じ込めてある。
 * 削除手順の正本 = src/domain/importWorkspace.ts 冒頭の削除手順マニフェスト。
 *
 * 流れ: ファイル選択 → (暗号化封筒ならパスフレーズ入力 → 復号) → ユーザー選択と
 * 件数確認 → 既存データへ追記。パスフレーズは state に持つだけで永続化しない。
 */

import { useMemo, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import {
  convertWorkspaceBackup,
  decryptWorkspaceBackupJson,
  detectWorkspaceBackupFile,
  listImportCandidates,
  type WorkspaceImportCandidate,
  type WorkspaceImportData,
} from '../../domain/importWorkspace';
import type { AppRuntime } from '../appRuntime';
import { useRegisterOverlay } from '../registries';
import { pickTextFile } from '../files';
import { errorText, s } from '../../i18n';
import { UI } from '../../ui-contract';

/** 暗号化封筒のパスフレーズ入力。復号できた平文 JSON だけを親へ渡す。 */
function WorkspacePassphraseDialog({
  json,
  onDecrypted,
  onClose,
}: {
  json: string;
  onDecrypted: (plainJson: string) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  // パスフレーズはこの state だけに置く (localStorage / IndexedDB へ書かない)。
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy || passphrase === '') return;
    setBusy(true);
    setError(null);
    let plainJson: string;
    try {
      plainJson = await decryptWorkspaceBackupJson(json, passphrase);
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
      return;
    }
    setBusy(false);
    onDecrypted(plainJson);
  }

  return (
    <Modal
      title={s.settings.workspaceImport.passphraseTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <p className="muted">{s.settings.workspaceImport.passphraseHint}</p>
      <div className="settingsField">
        <span className="section-label">{s.settings.workspaceImport.passphrase}</span>
        <input
          className="input"
          type="password"
          value={passphrase}
          aria-label={s.settings.workspaceImport.passphrase}
          autoComplete="off"
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </div>
      {error ? <p className="dangerText">{error}</p> : null}
      <div className="settingsRowActions">
        <Button
          variant="primary"
          disabled={busy || passphrase === ''}
          onClick={() => void submit()}
        >
          {s.settings.workspaceImport.decrypt}
        </Button>
      </div>
    </Modal>
  );
}

/** 移行内容の確認 (ユーザー選択 + 件数) と追記実行。 */
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

  // バックアップ全量の再パースは重い。ユーザーを変えたときだけやり直す。
  const converted = useMemo((): { data: WorkspaceImportData | null; error: string | null } => {
    if (!userId) return { data: null, error: null };
    try {
      return { data: convertWorkspaceBackup(json, userId), error: null };
    } catch (e) {
      return { data: null, error: errorText(e) };
    }
  }, [json, userId]);
  const data = converted.data;

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
      dataUi={UI.settings.workspaceImportDialog}
    >
      <div className="settingsField">
        <span className="section-label">{s.settings.workspaceImport.user}</span>
        <select
          className="input"
          value={userId}
          aria-label={s.settings.workspaceImport.user}
          data-ui={UI.settings.workspaceImportUser}
          onChange={(e) => setUserId(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {converted.error ? <p className="dangerText">{converted.error}</p> : null}
      {data ? (
        <>
          <p>{s.settings.workspaceImport.counts(data.patients.length, data.places.length)}</p>
          <p className="muted">{s.settings.workspaceImport.appendOnly}</p>
          {data.notes.includes('closingPresetSkipped') ? (
            <p className="muted">{s.settings.workspaceImport.noteClosingPreset}</p>
          ) : null}
          {data.otherUserStandingMemoCount > 0 ? (
            <p className="muted">
              {s.settings.workspaceImport.noteOtherUserMemos(data.otherUserStandingMemoCount)}
            </p>
          ) : null}
          <div className="settingsRowActions">
            <Button
              variant="primary"
              disabled={busy}
              dataUi={UI.settings.workspaceImportApply}
              onClick={() => void apply()}
            >
              {s.settings.workspaceImport.apply}
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

type ImportStage =
  | { kind: 'passphrase'; json: string }
  | { kind: 'preview'; json: string; candidates: WorkspaceImportCandidate[] };

export function WorkspaceImportSection({ runtime }: { runtime: AppRuntime }) {
  const toast = useToast();
  const [stage, setStage] = useState<ImportStage | null>(null);

  /** 平文封筒からユーザー候補を読み、確認画面へ進む (読めなければ何も開かない = fail-closed)。 */
  function openPreview(plainJson: string): void {
    try {
      const candidates = listImportCandidates(plainJson);
      if (candidates.length === 0) {
        toast.show(s.settings.workspaceImport.noUsers, 'error');
        setStage(null);
        return;
      }
      setStage({ kind: 'preview', json: plainJson, candidates });
    } catch (e) {
      console.error('workspace import failed:', e);
      toast.show(s.settings.workspaceImport.failed(errorText(e)), 'error');
      setStage(null);
    }
  }

  async function pick(): Promise<void> {
    try {
      const picked = await pickTextFile('.json,application/json');
      if (!picked) return;
      // 移行元は暗号化書き出しが既定。平文封筒 (旧い書き出し) もそのまま読む。
      if (detectWorkspaceBackupFile(picked.text) === 'encrypted') {
        setStage({ kind: 'passphrase', json: picked.text });
        return;
      }
      openPreview(picked.text);
    } catch (e) {
      console.error('workspace import pick failed:', e);
      toast.show(s.settings.workspaceImport.failed(errorText(e)), 'error');
    }
  }

  return (
    <div className="card card--pad settingsSection" data-ui={UI.settings.workspaceImportSection}>
      <div className="section-label">{s.settings.workspaceImport.section}</div>
      <div className="settingsRowActions">
        <Button dataUi={UI.settings.workspaceImportPick} onClick={() => void pick()}>
          {s.settings.workspaceImport.pick}
        </Button>
      </div>
      {stage?.kind === 'passphrase' ? (
        <WorkspacePassphraseDialog
          json={stage.json}
          onDecrypted={(plainJson) => openPreview(plainJson)}
          onClose={() => setStage(null)}
        />
      ) : null}
      {stage?.kind === 'preview' ? (
        <WorkspaceImportDialog
          json={stage.json}
          candidates={stage.candidates}
          runtime={runtime}
          onClose={() => setStage(null)}
        />
      ) : null}
    </div>
  );
}
