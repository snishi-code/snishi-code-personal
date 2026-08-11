/*
 * CSV 取込 — プロファイル管理（指示書 §1-1）と AI プロファイルビルダー（§6）。
 *
 * プロファイル管理:
 *  - 一覧（組み込みバッジ・dslVersion / digest 短縮表示）・削除（組み込みも可。binding /
 *    decision は残る旨を確認ダイアログに明示）・「組み込みプロファイルを復元」（冪等・
 *    restoreBuiltinImportProfiles の配線・結果は toast）。
 *  - 追加は JSON 貼付（parseImportProfileDsl の strict 検証・fail-closed・部分保存なし）。
 *    編集は v1 では「JSON を表示してコピー → 貼付で新規 / 上書き」（フォームエディタは作らない）。
 *  - 検証失敗の表示は importDslIssueText（zod issue → 日本語）。英語の既定 message は出さない。
 *
 * AI ビルダー（アプリは AI に接続しない）:
 *  1. 未知 CSV を選択 → ヘッダー + サンプル行（先頭 5 行）を抽出
 *  2. 開示とマスク: 列ごとに そのまま / マスク(***) / 除外 を選び、コピー前に
 *     「AI に送る内容の完全プレビュー」（= 依頼文全文）を表示する
 *  3. 依頼文 = buildProfileBuilderPrompt（インジェクション対策文言込み・domain 既存）
 *  4. 返書貼付 → parseImportProfileDsl（strict）→ 同じ CSV への**全行勘定**の実適用プレビュー
 *     （§4-2 の件数会計。先頭 N 行だけの合否にしない = AI の過剰 skip で後半が脱落しても件数で見える）
 *  5. 確認 → 名前 → 保存（失敗は部分保存しない・再貼付で何度でもやり直せる）→ 取込フローへ続く導線
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { SelectInput, TextArea, TextInput } from '@snishi/foundation/ui/Field';
import { useToast } from '@snishi/foundation/ui/toast';
import { ConfirmDialog, Modal, useDirtyGuard } from '../overlays';
import { Money } from '../money';
import { useLedger } from '../../state/store';
import {
  decodeCsvBytes,
  extractCsvTable,
  parseCsv,
  CSV_ENCODINGS,
  type CsvEncoding,
} from '../../domain/importCsv';
import {
  evaluateProfileText,
  parseImportProfileDsl,
  type ImportProfile,
  type ImportProfileDsl,
  type ImportRowSkipCode,
  type ProfileEvaluation,
} from '../../domain/importDsl';
import {
  buildProfileBuilderPrompt,
  extractProfileBuilderReplyJson,
} from '../../domain/importPrompt';
import { profileDslDigest } from '../../domain/importIdentity';
import { newId } from '../../domain/ids';
import { dslIssuesText } from '../importDslIssueText';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';
import { nowIso } from '../../util/time';

/** AI へ送るサンプル行数（§6-1 の既定）。 */
const SAMPLE_ROW_COUNT = 5;
/** 実適用プレビューに出す正規化行の先頭件数（件数会計は常に全行）。 */
const PREVIEW_ROW_COUNT = 5;

/** クリップボードへコピー（失敗は false。外部送信なし・端末内のみ）。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function skipReasonLabel(code: ImportRowSkipCode): string {
  if (code === 'blank-line') return t('csvImport.skipReason.blank-line');
  if (code === 'before-header') return t('csvImport.skipReason.before-header');
  return t('csvImport.skipReason.rule', { reason: code.slice('rule:'.length) });
}

/* ── プロファイル管理タブ ── */

export function CsvImportProfiles({
  onContinueToImport,
}: {
  /** ビルダー保存後の導線: 保存した profile と選択中ファイルで通常の取込フローへ。 */
  onContinueToImport: (profileId: string, file: { name: string; bytes: Uint8Array }) => void;
}) {
  const { ledger, removeImportProfile, restoreBuiltinProfiles } = useLedger();
  const profiles = useMemo(() => ledger?.importProfiles ?? [], [ledger]);

  const [builderOpen, setBuilderOpen] = useState(false);
  const [jsonTarget, setJsonTarget] = useState<ImportProfile | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ImportProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [digests, setDigests] = useState<Record<string, string>>({});

  // digest（§1-1 の短縮表示）は WebCrypto = async のため描画後に埋める。
  useEffect(() => {
    let active = true;
    (async () => {
      const entries = await Promise.all(
        profiles.map(async (p) => [p.id, await profileDslDigest(p.dsl)] as const),
      );
      if (active) setDigests(Object.fromEntries(entries));
    })();
    return () => {
      active = false;
    };
  }, [profiles]);

  async function restore() {
    if (busy) return;
    setBusy(true);
    try {
      await restoreBuiltinProfiles();
    } catch {
      // store が toast 済み。
    } finally {
      setBusy(false);
    }
  }

  if (builderOpen) {
    return (
      <ProfileBuilderPanel
        onClose={() => setBuilderOpen(false)}
        onSaved={(profileId, file) => {
          setBuilderOpen(false);
          onContinueToImport(profileId, file);
        }}
      />
    );
  }

  return (
    <>
      <div className="card card--pad stack">
        <p className="field__hint">{t('csvImport.profiles.intro')}</p>
        <div className="toolbar">
          <button
            type="button"
            className="btn"
            onClick={() => setBuilderOpen(true)}
            data-ui={UI.csvImport.builderOpen}
          >
            <Icon name="add" size={18} />
            {t('csvImport.builder.open')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setPasteOpen(true)}
            data-ui={UI.csvImport.profilesPasteOpen}
          >
            <Icon name="edit" size={18} />
            {t('csvImport.profiles.pasteOpen')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void restore()}
            data-ui={UI.csvImport.profilesRestore}
          >
            <Icon name="restore" size={18} />
            {t('csvImport.profiles.restoreBuiltin')}
          </button>
        </div>
      </div>

      {profiles.length === 0 ? (
        <div className="card card--pad empty">{t('csvImport.profiles.empty')}</div>
      ) : (
        <ul className="card list" data-ui={UI.csvImport.profilesList}>
          {profiles.map((p) => (
            <li key={p.id} className="list__item" data-ui={UI.csvImport.profileRow}>
              <div className="list__main">
                <div className="list__title">
                  {p.builtin !== undefined ? (
                    <span className="tag tag--teal">{t('csvImport.profiles.builtinTag')}</span>
                  ) : null}{' '}
                  {p.name}
                </div>
                <div className="list__sub">
                  {t('csvImport.profiles.meta', {
                    version: p.dsl.dslVersion,
                    digest: digests[p.id]?.slice(0, 8) ?? '…',
                  })}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setJsonTarget(p)}
                aria-label={`${t('csvImport.profiles.viewJson')}: ${p.name}`}
                data-ui={UI.csvImport.profileJsonOpen}
              >
                <Icon name="expand" size={18} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setDeleteTarget(p)}
                aria-label={`${t('csvImport.profiles.delete')}: ${p.name}`}
                data-ui={UI.csvImport.profileDelete}
              >
                <Icon name="delete" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {jsonTarget ? (
        <ProfileJsonSheet profile={jsonTarget} onClose={() => setJsonTarget(null)} />
      ) : null}
      {pasteOpen ? (
        <ProfilePasteSheet profiles={profiles} onClose={() => setPasteOpen(false)} />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={t('csvImport.profiles.deleteConfirmTitle')}
          body={t('csvImport.profiles.deleteConfirmBody', { name: deleteTarget.name })}
          confirmLabel={t('csvImport.profiles.delete')}
          danger
          dataUi={UI.csvImport.profileDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            await removeImportProfile(target.id).catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );
}

/* ── JSON 表示（編集はコピー → 貼付で行う・§1-1） ── */

function ProfileJsonSheet({ profile, onClose }: { profile: ImportProfile; onClose: () => void }) {
  const toast = useToast();
  const jsonText = useMemo(() => JSON.stringify(profile.dsl, null, 2), [profile]);

  async function copy() {
    if (await copyToClipboard(jsonText)) toast.show(t('csvImport.profiles.copied'), 'success');
    else toast.show(t('csvImport.profiles.copyFailed'), 'error');
  }

  return (
    <Modal
      title={`${t('csvImport.profiles.jsonTitle')} — ${profile.name}`}
      onClose={onClose}
      dataUi={UI.csvImport.profileJsonSheet}
      footer={
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => void copy()}
          data-ui={UI.csvImport.profileJsonCopy}
        >
          {t('csvImport.profiles.copy')}
        </button>
      }
    >
      <div className="stack">
        <p className="field__hint">{t('csvImport.profiles.jsonHint')}</p>
        <textarea
          className="textarea"
          readOnly
          rows={14}
          value={jsonText}
          aria-label={t('csvImport.profiles.jsonTitle')}
          spellCheck={false}
          data-ui={UI.csvImport.profileJsonText}
        />
      </div>
    </Modal>
  );
}

/* ── JSON 貼付での追加 / 上書き（strict 検証・fail-closed・部分保存なし・§1-1） ── */

function ProfilePasteSheet({
  profiles,
  onClose,
}: {
  profiles: readonly ImportProfile[];
  onClose: () => void;
}) {
  const { saveImportProfile } = useLedger();
  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dirty = name.trim() !== '' || jsonText.trim() !== '';
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  function onTargetChange(v: string) {
    setTargetId(v);
    const target = profiles.find((p) => p.id === v);
    // 上書き対象を選んだら名前を引き継ぐ（別名にしたければ書き換えられる）。
    if (target !== undefined && name.trim() === '') setName(target.name);
  }

  async function submit() {
    if (submitting) return;
    setJsonError(null);
    // 検証は 2 段: JSON として読めるか → DSL schema（未知キー拒否・fail-closed）。
    // どちらで失敗しても何も保存しない（部分保存なし）。
    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch {
      setJsonError(t('csvImport.profiles.jsonParseError'));
      return;
    }
    let dsl: ImportProfileDsl;
    try {
      dsl = parseImportProfileDsl(value);
    } catch (e) {
      // 検証失敗は日本語で理由を見せる（元の JSON を渡すと必須欠落と型違いを区別できる）。
      setJsonError(dslIssuesText(e, value));
      return;
    }
    setSubmitting(true);
    try {
      const ts = nowIso();
      const existing = profiles.find((p) => p.id === targetId);
      // builtin 印はユーザー入力から持ち込ませない（repository が prev の印を維持する・§1-1）。
      await saveImportProfile({
        id: existing?.id ?? newId(),
        name: name.trim(),
        dsl,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      });
      onClose();
    } catch {
      // store が toast 済み。開いたまま修正できるようにする。
      setSubmitting(false);
    }
  }

  const valid = name.trim() !== '' && jsonText.trim() !== '';

  return (
    <>
      <Modal
        title={t('csvImport.profiles.pasteTitle')}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={UI.csvImport.pasteSheet}
        footer={
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void submit()}
            disabled={!valid || submitting}
            data-ui={UI.csvImport.pasteSave}
          >
            {t('csvImport.profiles.pasteSave')}
          </button>
        }
      >
        <div className="stack">
          <p className="field__hint">{t('csvImport.profiles.pasteIntro')}</p>
          <SelectInput
            label={t('csvImport.profiles.pasteTarget')}
            value={targetId}
            onChange={onTargetChange}
            options={[
              { value: '', label: t('csvImport.profiles.pasteTargetNew') },
              ...profiles.map((p) => ({
                value: p.id,
                label: t('csvImport.profiles.pasteTargetOverwrite', { name: p.name }),
              })),
            ]}
            dataUi={UI.csvImport.pasteTarget}
          />
          <TextInput
            label={t('csvImport.profiles.pasteName')}
            value={name}
            onChange={setName}
            required
            dataUi={UI.csvImport.pasteName}
          />
          <TextArea
            label={t('csvImport.profiles.pasteJson')}
            value={jsonText}
            onChange={(v) => {
              setJsonText(v);
              setJsonError(null);
            }}
            required
            {...(jsonError !== null ? { error: jsonError } : {})}
            dataUi={UI.csvImport.pasteJson}
          />
        </div>
      </Modal>
      {discardConfirm}
    </>
  );
}

/* ── AI プロファイルビルダー（§6） ── */

/** 列ごとの送信モード（§6-1: マスク = 値を *** の同型ダミーへ・除外 = 列ごと送らない）。 */
type ColumnSendMode = 'raw' | 'mask' | 'omit';

type SampleState =
  | { kind: 'ok'; header: string[]; rows: string[][] }
  | { kind: 'error'; message: string };

function ProfileBuilderPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (profileId: string, file: { name: string; bytes: Uint8Array }) => void;
}) {
  const { ledger, saveImportProfile } = useLedger();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const currency = ledger?.settings.currency ?? 'JPY';

  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [encoding, setEncoding] = useState<CsvEncoding>('utf-8-sig');
  const [delimiter, setDelimiter] = useState(',');
  const [headerRowText, setHeaderRowText] = useState('0');
  const [note, setNote] = useState('');
  const [modes, setModes] = useState<Record<string, ColumnSendMode>>({});
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    dsl: ImportProfileDsl;
    evaluation: ProfileEvaluation;
  } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // error 行が残る profile の保存前確認（項目2）。保存は許すが、error 行がこの profile
  // では取り込まれない事実（fail-closed）を明示してから進める。
  const [confirmErrorSave, setConfirmErrorSave] = useState(false);

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    void (async () => {
      try {
        const bytes = new Uint8Array(await picked.arrayBuffer());
        setFile({ name: picked.name, bytes });
        // ファイルを替えたらマスク選択・返書・プレビューを作り直す（前のファイル前提を残さない）。
        setModes({});
        setReply('');
        setReplyError(null);
        setPreview(null);
      } catch {
        setReplyError(t('csvImport.readFailed'));
      }
    })();
  }

  const headerRowIndex = /^\d+$/.test(headerRowText) ? Number.parseInt(headerRowText, 10) : 0;

  // サンプル抽出（ヘッダー + 先頭 N 行）。読めない場合は理由を見せて設定を直させる（fail-closed）。
  const sample: SampleState | null = useMemo(() => {
    if (!file) return null;
    try {
      const text = decodeCsvBytes(file.bytes, encoding);
      const table = extractCsvTable(parseCsv(text, { delimiter }), headerRowIndex);
      const rows = table.dataRecords
        .slice(0, SAMPLE_ROW_COUNT)
        .map((r) => table.header.map((_, i) => r.cells[i] ?? ''));
      return { kind: 'ok', header: table.header, rows };
    } catch (e) {
      return { kind: 'error', message: errorText(e) };
    }
  }, [file, encoding, delimiter, headerRowIndex]);

  const modeOf = (column: string): ColumnSendMode => modes[column] ?? 'raw';

  // マスク適用後の送信素材（§6-2: プロンプトにはこれだけが入る）。
  const masked = useMemo(() => {
    if (sample === null || sample.kind !== 'ok') return null;
    const mode = (column: string): ColumnSendMode => modes[column] ?? 'raw';
    const keptIndices = sample.header
      .map((column, i) => ({ column, i }))
      .filter(({ column }) => mode(column) !== 'omit');
    const rows = sample.rows.map((row) =>
      keptIndices.map(({ column, i }) => {
        const cell = row[i]!;
        // マスクは空セルの「空である」構造だけ残す（値の実体は *** の同型ダミーへ）。
        if (mode(column) === 'mask') return cell.trim() === '' ? cell : '***';
        return cell;
      }),
    );
    return { header: keptIndices.map(({ column }) => column), rows };
  }, [sample, modes]);

  const prompt = useMemo(() => {
    if (masked === null) return null;
    const sourceNote = note.trim();
    return buildProfileBuilderPrompt({
      header: masked.header,
      sampleRows: masked.rows,
      delimiter,
      encoding,
      ...(sourceNote !== '' ? { sourceNote } : {}),
    });
  }, [masked, delimiter, encoding, note]);

  async function copyPrompt() {
    if (prompt === null) return;
    if (await copyToClipboard(prompt)) toast.show(t('csvImport.profiles.copied'), 'success');
    else toast.show(t('csvImport.profiles.copyFailed'), 'error');
  }

  /** 返書の検証 → 同じ CSV への実適用プレビュー（全行勘定・§6-3）。 */
  function checkReply() {
    setPreview(null);
    setReplyError(null);
    if (!file) return;
    const jsonText = extractProfileBuilderReplyJson(reply);
    if (jsonText === '') {
      setReplyError(t('csvImport.builder.replyEmpty'));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch {
      setReplyError(t('csvImport.profiles.jsonParseError'));
      return;
    }
    let dsl: ImportProfileDsl;
    try {
      dsl = parseImportProfileDsl(value);
    } catch (e) {
      setReplyError(dslIssuesText(e, value));
      return;
    }
    try {
      // 実適用は DSL 自身の fileFormat（encoding / delimiter / headerRowIndex）で行う =
      // 保存後の取込フローと同じ経路。ファイル単位のエラーはここで見えて作り直せる。
      const text = decodeCsvBytes(file.bytes, dsl.fileFormat.encoding);
      setPreview({ dsl, evaluation: evaluateProfileText(dsl, text) });
    } catch (e) {
      setReplyError(errorText(e));
    }
  }

  async function save() {
    if (preview === null || file === null || name.trim() === '' || busy) return;
    setBusy(true);
    try {
      const ts = nowIso();
      const saved = await saveImportProfile({
        id: newId(),
        name: name.trim(),
        dsl: preview.dsl,
        createdAt: ts,
        updatedAt: ts,
      });
      onSaved(saved.id, file);
    } catch {
      // store が toast 済み。失敗は部分保存しない（再貼付でやり直せる）。
      setBusy(false);
    }
  }

  const skipCounts = useMemo(() => {
    const map = new Map<ImportRowSkipCode, number>();
    for (const s of preview?.evaluation.skipped ?? []) {
      map.set(s.reasonCode, (map.get(s.reasonCode) ?? 0) + 1);
    }
    return map;
  }, [preview]);

  return (
    <div data-ui={UI.csvImport.builder}>
      {/* 手順 1: ファイルと読み取り設定 */}
      <div className="card card--pad stack">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <p className="section-label" style={{ margin: 0 }}>
            {t('csvImport.builder.title')}
          </p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            data-ui={UI.csvImport.builderClose}
          >
            <Icon name="close" size={16} />
            {t('csvImport.builder.close')}
          </button>
        </div>
        <p className="field__hint">{t('csvImport.builder.intro')}</p>
        <div>
          <p className="section-label">{t('csvImport.builder.fileLabel')}</p>
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              onClick={() => fileRef.current?.click()}
              data-ui={UI.csvImport.builderFilePick}
            >
              <Icon name="upload" size={18} />
              {t('csvImport.builder.filePick')}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              {file ? file.name : t('csvImport.fileNone')}
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFileSelected}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            data-ui={UI.csvImport.builderFileInput}
          />
        </div>
        <SelectInput
          label={t('csvImport.builder.encoding')}
          value={encoding}
          onChange={(v) => setEncoding(v as CsvEncoding)}
          options={CSV_ENCODINGS.map((e) => ({ value: e, label: e }))}
          dataUi={UI.csvImport.builderEncoding}
        />
        <TextInput
          label={t('csvImport.builder.delimiter')}
          value={delimiter}
          onChange={(v) => setDelimiter(v === '' ? '' : v.slice(-1))}
          dataUi={UI.csvImport.builderDelimiter}
        />
        <TextInput
          label={t('csvImport.builder.headerRow')}
          value={headerRowText}
          onChange={(v) => setHeaderRowText(v.replace(/[^\d]/g, ''))}
          inputMode="numeric"
          dataUi={UI.csvImport.builderHeaderRow}
        />
        <TextInput
          label={t('csvImport.builder.note')}
          value={note}
          onChange={setNote}
          hint={t('csvImport.builder.noteHint')}
          dataUi={UI.csvImport.builderNote}
        />
        {sample !== null && sample.kind === 'error' ? (
          <p className="field__error" role="alert" style={{ display: 'flex', gap: 6 }}>
            <Icon name="alert" size={16} />
            {sample.message}
          </p>
        ) : null}
      </div>

      {/* 手順 2: 開示とマスク（列ごと）+ 送信内容の完全プレビュー + コピー */}
      {sample !== null && sample.kind === 'ok' && prompt !== null ? (
        <div className="card card--pad stack">
          <p className="section-label">{t('csvImport.builder.maskTitle')}</p>
          <p className="field__hint">
            {t('csvImport.builder.maskIntro', { count: sample.rows.length })}
          </p>
          {/* csv-import__mask-list: セレクトの width:100% が列名を幅 0 に潰す flex の
              組み合わせを app.css で打ち消す（項目10）。 */}
          <ul className="list csv-import__mask-list" data-ui={UI.csvImport.builderMaskList}>
            {sample.header.map((column, i) => (
              <li key={column} className="list__item">
                <div className="list__main">
                  <div className="list__title">{column}</div>
                  <div className="list__sub">{sample.rows[0]?.[i] ?? ''}</div>
                </div>
                <select
                  className="select"
                  value={modeOf(column)}
                  aria-label={`${t('csvImport.builder.maskTitle')}: ${column}`}
                  onChange={(e) =>
                    setModes((prev) => ({ ...prev, [column]: e.target.value as ColumnSendMode }))
                  }
                  data-ui={UI.csvImport.builderMaskMode}
                >
                  <option value="raw">{t('csvImport.builder.maskMode.raw')}</option>
                  <option value="mask">{t('csvImport.builder.maskMode.mask')}</option>
                  <option value="omit">{t('csvImport.builder.maskMode.omit')}</option>
                </select>
              </li>
            ))}
          </ul>
          <p className="section-label">{t('csvImport.builder.promptTitle')}</p>
          <p className="field__hint">{t('csvImport.builder.promptHint')}</p>
          <textarea
            className="textarea"
            readOnly
            rows={12}
            value={prompt}
            aria-label={t('csvImport.builder.promptTitle')}
            spellCheck={false}
            data-ui={UI.csvImport.builderPrompt}
          />
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void copyPrompt()}
            data-ui={UI.csvImport.builderPromptCopy}
          >
            {t('csvImport.builder.promptCopy')}
          </button>
        </div>
      ) : null}

      {/* 手順 3: 返書貼付 → 検証（fail-closed・何度でも貼り直せる） */}
      {sample !== null && sample.kind === 'ok' ? (
        <div className="card card--pad stack">
          <p className="section-label">{t('csvImport.builder.replyTitle')}</p>
          <TextArea
            label={t('csvImport.builder.reply')}
            value={reply}
            onChange={(v) => {
              setReply(v);
              // 返書を編集したらプレビューは失効させる（表示と保存対象のズレを作らない）。
              setPreview(null);
              setReplyError(null);
            }}
            hint={t('csvImport.builder.replyHint')}
            {...(replyError !== null ? { error: replyError } : {})}
            dataUi={UI.csvImport.builderReply}
          />
          <button
            type="button"
            className="btn btn--block"
            disabled={reply.trim() === ''}
            onClick={checkReply}
            data-ui={UI.csvImport.builderCheck}
          >
            {t('csvImport.builder.check')}
          </button>
        </div>
      ) : null}

      {/* 手順 4: 実適用プレビュー（全行勘定の件数会計・§4-2）→ 名前 → 保存 */}
      {preview !== null ? (
        <div className="card card--pad stack" data-ui={UI.csvImport.builderPreview}>
          <p className="section-label">{t('csvImport.builder.previewTitle')}</p>
          <p className="field__hint">{t('csvImport.builder.previewIntro')}</p>
          <div className="kv">
            <span className="muted">{t('csvImport.rowsTotal')}</span>
            <span>{preview.evaluation.totalRowCount}</span>
          </div>
          <div className="kv">
            <span className="muted">{t('csvImport.rowsTarget')}</span>
            <span>{preview.evaluation.normalized.length}</span>
          </div>
          <div className="kv">
            <span className="muted">{t('csvImport.rowsSkipped')}</span>
            <span>{preview.evaluation.skipped.length}</span>
          </div>
          {[...skipCounts].map(([code, count]) => (
            <div className="kv" key={code}>
              <span className="muted">・{skipReasonLabel(code)}</span>
              <span>{t('csvImport.kindCount', { count })}</span>
            </div>
          ))}
          <div className="kv">
            <span className="muted">{t('csvImport.rowsError')}</span>
            <span>{preview.evaluation.errors.length}</span>
          </div>
          {preview.evaluation.normalized.length > 0 ? (
            <>
              <p className="section-label">
                {t('csvImport.builder.previewRows', {
                  count: Math.min(PREVIEW_ROW_COUNT, preview.evaluation.normalized.length),
                })}
              </p>
              <ul className="list">
                {preview.evaluation.normalized.slice(0, PREVIEW_ROW_COUNT).map((row) => (
                  <li key={row.rowIndex} className="list__item">
                    <div className="list__main">
                      <div className="list__title">{row.description || row.kind}</div>
                      <div className="list__sub">
                        {row.date}・{row.kind}
                      </div>
                    </div>
                    <span className="list__amount">
                      <Money amount={row.amount} currency={currency} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <TextInput
            label={t('csvImport.builder.name')}
            value={name}
            onChange={setName}
            required
            dataUi={UI.csvImport.builderName}
          />
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={name.trim() === '' || busy}
            onClick={() => {
              // error 行が残っているときは黙って保存しない（項目2）。件数を明示した
              // 確認を挟む（error 0 なら従来どおり直接保存）。
              if (preview.evaluation.errors.length > 0) setConfirmErrorSave(true);
              else void save();
            }}
            data-ui={UI.csvImport.builderSave}
          >
            {t('csvImport.builder.save')}
          </button>
        </div>
      ) : null}

      {confirmErrorSave && preview !== null ? (
        <ConfirmDialog
          title={t('csvImport.builder.saveErrorsTitle')}
          body={t('csvImport.builder.saveErrorsBody', {
            count: preview.evaluation.errors.length,
          })}
          confirmLabel={t('csvImport.builder.saveErrorsConfirm')}
          dataUi={UI.csvImport.builderSaveErrorsConfirm}
          onCancel={() => setConfirmErrorSave(false)}
          onConfirm={() => {
            setConfirmErrorSave(false);
            void save();
          }}
        />
      ) : null}
    </div>
  );
}
