/*
 * CSV 取込（Import Profile・指示書 §4 / §1-1b / §4-6）。
 *
 * フロー: ファイル選択 → profile 選択（手動）→ binding（取込元）未設定ならセットアップシート →
 * 変換（件数会計を常時表示・§4-2 の保存則）→ 決定的スキップ（ImportDecision 照合・§4 手順3）→
 * レビューキュー（画面内 state・保存しない）→ applyImportBatch（原子性は data 層・§4-4）。
 *
 *  - レビューの配線順序（処理順の固定・importDedup.ts ヘッダーと対）:
 *    ① 全 valid 行の正規化（evaluateProfileText）→ ② **全母集合**で rowKey / occurrence 付与
 *    （attachRowKeys(binding.sourceId)）→ ③ decision 照合（resolveImportRows・台帳
 *    スナップショットの全件・**読み取り専用**）→ ④ 取込開始日 cutoff
 *    （applyImportFromDateCutoff・§B: 未決定かつ binding.importFromDate より前の行だけを
 *    明示 skip「取込開始日より前」へ移し件数会計に合流。決定は作らない = 可逆）→
 *    ⑤ invalid 行は隠さず error（件数会計の保存則）。dangling は自動で削除せず「要再確認」行と
 *    してレビューへ出し、解除はユーザーの明示操作（store 経由）だけが行う（§1-2）。
 *    fingerprint 型キーの決定済みヒットは同一ファイル（fileHash 一致）の再取込だけ黙って
 *    スキップし、別ファイルでは「以前の取込と同一の可能性」としてレビューへ出す
 *    （既定の提案 = スキップ・確定はユーザー・作者決定 2026-08-11・P1-1）。
 *  - 適用は expectedLedgerVersion（レビュー時点の meta 世代）+ profileDigest で全拒否できる
 *    （stale なレビューで保存しない）。適用成功・失敗のどちらでもレビューを作り直して同期する。
 *  - 決定済み一覧（§4-6）: profile・status で絞り込み、無視・リンクの解除（確認 1 つ・冪等）と
 *    リンク先仕訳の表示へ到達できる。登録済み（registered）の解除は仕訳の削除が正道
 *    （削除 cascade が decision を同時解除する）なので、ここには解除ボタンを出さない。
 *  - 個別行の「編集して適用」はホームの仕訳入力シート（EntrySheet）をそのまま再利用する
 *    （作者決定 2026-08-11・監査 P1-2）。候補・検証は通常入力と完全に同一で、CSV 側の
 *    追加制限・追加緩和は作らない。保存だけが register action（仕訳 + decision の同一 tx）
 *    へ流れる。
 *  - 行種一括適用は計上先をダイアログ内で選ぶ一般形（監査 P1-4）。既定計上先の無い行種・
 *    組み込み以外の profile でも一括でき、候補は既存の仕訳入力の候補規則（MODE_FLOW /
 *    MODE_ROLES）を正本にする。「この計上先を既定にする」で binding の kindDestinations へ
 *    学習できる（適用と同一 tx・bindingUpdate）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Segmented } from '@snishi/foundation/ui/Segmented';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { ConfirmDialog, Modal, useDirtyGuard } from '../overlays';
import { CsvImportProfiles } from './CsvImportProfiles';
import { EntrySheet } from './EntrySheet';
import { AccountPicker } from '../AccountPicker';
import { Money } from '../money';
import { useLedger } from '../../state/store';
import {
  getImportFileRecords,
  loadLedger as loadLedgerSnapshot,
  type ImportBatchAction,
  type LedgerVersion,
} from '../../data/repository';
import { decodeCsvBytes } from '../../domain/importCsv';
import {
  evaluateProfileText,
  type ImportProfile,
  type ImportRowErrorCode,
  type ImportRowSkipCode,
  type ProfileEvaluation,
} from '../../domain/importDsl';
import {
  attachRowKeys,
  parseRowKey,
  profileDslDigest,
  sha256HexOfBytes,
  type NormalizedRow,
  type RowKeyAttachment,
} from '../../domain/importIdentity';
import {
  applyImportFromDateCutoff,
  resolveImportRows,
  type ImportDecisionStatus,
  type ImportDecisionSummary,
  type ImportRowResolution,
} from '../../domain/importDedup';
import {
  PAYPAY_BUILTIN_ID,
  PAYPAY_KIND_HINTS,
  type ImportKindHint,
  type PaypayKind,
} from '../../domain/importProfilePresets';
import { buildSimpleEntry, type SimpleEntryInput } from '../../domain/entry';
import { isRecurringPostableRole } from '../../domain/recurring';
import { newId } from '../../domain/ids';
import { groupedAccountsByRole } from '../accountOptions';
import { MODE_FLOW, MODE_ROLES, type FormMode } from '../entryModes';
import { errorText, t } from '../../i18n';
import { UI } from '../../ui-contract';
import { nowIso } from '../../util/time';
import type { AccountRole } from '../../domain/accountRoles';
import type {
  Account,
  ImportDecision,
  ImportFileRecord,
  JournalEntry,
  ProfileBinding,
} from '../../domain/types';

/* ── 文言ヘルパ（キー欠落はコンパイルエラーになるテンプレートリテラル型） ── */

type RowErrorKey = `csvImport.rowError.${ImportRowErrorCode}`;
function rowErrorLabel(code: ImportRowErrorCode): string {
  const key: RowErrorKey = `csvImport.rowError.${code}`;
  return t(key);
}

type StatusKey = `csvImport.status.${ImportDecisionStatus}`;
function statusLabel(status: ImportDecisionStatus): string {
  const key: StatusKey = `csvImport.status.${status}`;
  return t(key);
}

function skipReasonLabel(code: ImportRowSkipCode): string {
  if (code === 'blank-line') return t('csvImport.skipReason.blank-line');
  if (code === 'before-header') return t('csvImport.skipReason.before-header');
  if (code === 'before-import-start') return t('csvImport.skipReason.before-import-start');
  return t('csvImport.skipReason.rule', { reason: code.slice('rule:'.length) });
}

/** rowKey の可読部分（§4-6）。ext = 識別子タプル / fp = 指紋の先頭 + 出現順。 */
function readableRowKey(key: string): string {
  const parsed = parseRowKey(key);
  if (parsed === undefined) return key;
  if (parsed.body.type === 'ext') return parsed.body.tuple.join(' / ');
  return t('csvImport.fpKey', {
    hash: parsed.body.fingerprint.slice(0, 8),
    n: parsed.body.occurrence,
  });
}

/* ── binding と行種の既定計上先 ── */

/** PayPay 組み込みで「獲得・取消の計上先」フィールドが書き込む行種（§3 の income-category 行種）。 */
const PAYPAY_INCOME_KINDS = (Object.keys(PAYPAY_KIND_HINTS) as PaypayKind[]).filter(
  (kind) => PAYPAY_KIND_HINTS[kind].counter === 'income-category',
);

function paypayHint(profile: ImportProfile, kind: string): ImportKindHint | undefined {
  if (profile.builtin?.builtinId !== PAYPAY_BUILTIN_ID) return undefined;
  return (PAYPAY_KIND_HINTS as Record<string, ImportKindHint | undefined>)[kind];
}

/**
 * 行種の既定計上先（一括適用・ワンタップ適用の対象になる）。
 * binding の行種→計上先が最優先。PayPay のチャージだけは binding のチャージ源泉を使う。
 * 無ければ行単位選択（支払い・送金系）。
 */
function defaultCounterFor(
  profile: ImportProfile,
  binding: ProfileBinding,
  kind: string,
): string | undefined {
  const dest = binding.kindDestinations[kind];
  if (dest !== undefined) return dest;
  if (paypayHint(profile, kind)?.counter === 'charge-source') return binding.chargeSourceAccountId;
  return undefined;
}

/**
 * binding が参照する科目の生存確認（soft reference・§1-1b）。壊れていたら再選択を促す
 * （fail-closed・黙って別科目に落とさない）。
 */
function bindingIsBroken(binding: ProfileBinding, accounts: Map<string, Account>): boolean {
  const own = accounts.get(binding.ownAccountId);
  if (!own || own.role !== 'daily-asset' || own.archived) return true;
  if (binding.chargeSourceAccountId !== undefined) {
    const source = accounts.get(binding.chargeSourceAccountId);
    if (!source || source.role !== 'daily-asset' || source.archived) return true;
  }
  for (const accountId of Object.values(binding.kindDestinations)) {
    const account = accounts.get(accountId);
    if (!account || !isRecurringPostableRole(account.role) || account.archived) return true;
  }
  return false;
}

/* ── レビュー状態（画面内 state・保存しない・§4 手順 4） ── */

interface ReviewState {
  /** 由来ファイル（選択中ファイルとの同一性は参照比較で判定する）。 */
  file: { name: string; bytes: Uint8Array };
  fileHash: string;
  profileId: string;
  /** レビュー表示時点の profile digest（§5-1。適用時に repository が再照合する）。 */
  profileDigest: string;
  /** 適用に使う binding。存在・科目 role 整合は適用時に repository が再検証する（監査 P1-3）。 */
  bindingId: string;
  ownAccountId: string;
  evaluation: ProfileEvaluation;
  /** rowKey 付きの正規化行（入力順）。resolutions と同順。 */
  rows: NormalizedRow[];
  resolutions: ImportRowResolution[];
  /** レビュー表示時点の台帳世代（適用の revision CAS に渡す・§4-4）。 */
  ledgerVersion: LedgerVersion;
  fileRecord?: ImportFileRecord;
}

/**
 * レビュー素材（CSV のデコード・評価・rowKey 付与・ハッシュ）のキャッシュ。
 * これらはファイル・profile・取込元が同じ間は決定的に同一なので、1 件適用するたびに
 * 作り直さない（12k 仕訳規模で適用 1 回ごとの体感遅延の主因だった）。キーは
 * bytes の参照 + profile DSL digest + binding の sourceId（rowKey の名前空間）+
 * 取込開始日（binding.importFromDate・§B）で、どれかが変われば全部作り直す。
 * **意味論は変えない**: キャッシュが効いている間の再構築は decision 照合・類似候補の提示・
 * 取込開始日 cutoff（処理順④）だけをやり直す。キャッシュ内容は cutoff **前**の全母集合
 * （occurrence 採番の安定に必要）。
 */
interface ReviewSourceCache {
  fileBytes: Uint8Array;
  profileDigest: string;
  sourceId: string;
  importFromDate: string | undefined;
  fileHash: string;
  evaluation: ProfileEvaluation;
  attachment: RowKeyAttachment;
}

/**
 * レビューを組み立てる（§4 手順 1〜3）。**完全に読み取り専用** — decision の削除・変更は
 * 一切しない。dangling の解除はレビュー行のユーザー明示操作（store 経由）だけが行う（§1-2）。
 */
async function computeReview(
  file: { name: string; bytes: Uint8Array },
  profileId: string,
  bindingId: string,
  sourceCache: { current: ReviewSourceCache | null },
): Promise<ReviewState> {
  const ledger = await loadLedgerSnapshot();
  const profile = ledger.importProfiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(t('error.importProfile.notFound'));
  const binding = ledger.profileBindings.find((b) => b.id === bindingId);
  if (!binding) throw new Error(t('csvImport.setupNeeded'));

  const profileDigest = await profileDslDigest(profile.dsl);
  let source = sourceCache.current;
  if (
    source === null ||
    source.fileBytes !== file.bytes ||
    source.profileDigest !== profileDigest ||
    source.sourceId !== binding.sourceId ||
    source.importFromDate !== binding.importFromDate
  ) {
    const text = decodeCsvBytes(file.bytes, profile.dsl.fileFormat.encoding);
    const evaluation = evaluateProfileText(profile.dsl, text);
    // 行キーの名前空間は不変の sourceId（表示名の改名・重複命名に影響されない・監査 P1-3）。
    // rowKey / occurrence は取込開始日に関わらず**全母集合**で付与する（処理順②・§B）。
    const attachment = await attachRowKeys(evaluation.normalized, binding.sourceId);
    const fileHash = await sha256HexOfBytes(file.bytes);
    source = {
      fileBytes: file.bytes,
      profileDigest,
      sourceId: binding.sourceId,
      importFromDate: binding.importFromDate,
      fileHash,
      evaluation,
      attachment,
    };
    sourceCache.current = source;
  }

  // 決定は台帳スナップショットの**全件**を使う（仕訳と同一トランザクション読み）。
  // fileHash（決定の由来ファイル）も要約へ載せる: fingerprint 型キーの決定済みヒットを
  // 黙ってスキップしてよいのは同一ファイルの再取込だけ（作者決定 2026-08-11・P1-1）。
  const decisions = new Map<string, ImportDecisionSummary>(
    ledger.importDecisions.map((d) => [
      d.key,
      {
        status: d.status,
        fileHash: d.provenance.fileHash,
        ...(d.entryId !== undefined ? { entryId: d.entryId } : {}),
      },
    ]),
  );
  const resolutions = resolveImportRows({
    rows: source.attachment.rows,
    decisions,
    existingEntries: ledger.journalEntries,
    fileHash: source.fileHash,
    ownAccountId: binding.ownAccountId,
  });
  // 取込開始日 cutoff（処理順④・§B）: 未決定かつ開始日より前の行だけを明示 skip
  // 「取込開始日より前」として件数会計へ合流させる（保存則: 総行数 = 取込対象 + skip +
  // error は不変）。決定は作らない = 開始日を早めれば当該行はレビューへ戻る（可逆）。
  const cutoff = applyImportFromDateCutoff(
    source.attachment.rows,
    resolutions,
    binding.importFromDate,
  );
  const evaluation: ProfileEvaluation =
    cutoff.skipped.length === 0
      ? source.evaluation
      : {
          ...source.evaluation,
          normalized: cutoff.rows,
          skipped: [...source.evaluation.skipped, ...cutoff.skipped].sort(
            (a, b) => a.rowIndex - b.rowIndex,
          ),
        };
  const fileRecord = (await getImportFileRecords())[source.fileHash];
  return {
    file,
    fileHash: source.fileHash,
    profileId,
    profileDigest,
    bindingId,
    ownAccountId: binding.ownAccountId,
    evaluation,
    rows: cutoff.rows,
    resolutions: cutoff.resolutions,
    ledgerVersion: { deviceId: ledger.meta.deviceId, revision: ledger.meta.revision },
    ...(fileRecord !== undefined ? { fileRecord } : {}),
  };
}

/* ── レビュー行のビュー（未解決のみ・行種でグループ化） ── */

interface ReviewRow {
  row: NormalizedRow;
  resolution: ImportRowResolution;
  defaultCounterId: string | undefined;
}

function unresolvedGroups(
  review: ReviewState,
  profile: ImportProfile,
  binding: ProfileBinding,
  priorConfirmedKeys: ReadonlySet<string>,
): { kind: string; rows: ReviewRow[] }[] {
  const byKind = new Map<string, ReviewRow[]>();
  review.rows.forEach((row, i) => {
    const resolution = review.resolutions[i]!;
    if (resolution.status === 'decided') return;
    // 「以前の取込と同一の可能性」行でユーザーがスキップを確定したものは決定済み扱いで除外
    // （決定は既に保存されている = 何も書かない。確定はこの画面のセッション内でだけ有効）。
    if (resolution.status === 'unresolved-prior-decision' && priorConfirmedKeys.has(row.rowKey)) {
      return;
    }
    const entry: ReviewRow = {
      row,
      resolution,
      defaultCounterId: defaultCounterFor(profile, binding, row.kind),
    };
    const list = byKind.get(row.kind);
    if (list) list.push(entry);
    else byKind.set(row.kind, [entry]);
  });
  return [...byKind].map(([kind, rows]) => ({ kind, rows }));
}

/**
 * 一括適用の対象 = 普通の未解決行のみ（§1-2・監査 P1-4 の一般化）。dangling と
 * 「以前の取込と同一の可能性」行は決定済みキーのため適用できない（alreadyDecided になる）。
 */
function bulkApplicableRows(rows: readonly ReviewRow[]): ReviewRow[] {
  return rows.filter((r) => r.resolution.status === 'unresolved');
}

/**
 * 行種 → 仕訳入力シートの初期モード（作者決定 2026-08-11・監査 P1-2）。
 * PayPay 組み込みのヒントから推定し、判定不能は簿記編集（manual）に落とす。
 * どのモードからでも簿記編集へ切り替えられるので、ここの推定は初期タブでしかない
 * （CSV 側の追加制限は作らない）。
 */
function formModeForRow(profile: ImportProfile, row: NormalizedRow): FormMode {
  const hint = paypayHint(profile, row.kind);
  if (hint === undefined) return 'manual';
  if (hint.counter === 'expense-per-row') return 'expense';
  // 獲得（自口座が借方）だけ収入フローに合う。取消（逆向き）は簿記編集で。
  if (hint.counter === 'income-category') return row.ownSide === 'debit' ? 'income' : 'manual';
  if (hint.counter === 'charge-source') return 'transfer';
  // per-row-counterparty のうち自分の銀行口座への出金（口座送金）だけ振替。
  // 送った/受け取った金額は相手が人なので簿記編集で自由に組む。
  return row.kind === '口座送金' ? 'transfer' : 'manual';
}

/** EntrySheet の初期値: CSV 行の値 + 自口座を行の借/貸側へ + 既定計上先があれば相手側へ。 */
function importEntryInput(reviewRow: ReviewRow, ownAccountId: string): SimpleEntryInput {
  const row = reviewRow.row;
  const counter = reviewRow.defaultCounterId ?? '';
  return {
    date: row.date,
    description: row.description || row.kind,
    debitAccountId: row.ownSide === 'debit' ? ownAccountId : counter,
    creditAccountId: row.ownSide === 'debit' ? counter : ownAccountId,
    amount: row.amount,
    kind: 'normal',
  };
}

/**
 * 一括適用の計上先候補 role。既存の仕訳入力の候補規則（MODE_FLOW / MODE_ROLES）を正本に、
 * 行種の推定モードと自口座側から相手側の role を引く。モードや自口座側が行ごとに割れる
 * 行種は簿記編集と同じ全候補に落とす（独自の絞り込みを発明しない）。
 */
function bulkCounterRoles(profile: ImportProfile, rows: readonly ReviewRow[]): AccountRole[] {
  const modes = new Set(rows.map((r) => formModeForRow(profile, r.row)));
  const sides = new Set(rows.map((r) => r.row.ownSide));
  const mode = modes.size === 1 ? [...modes][0]! : 'manual';
  if (mode === 'manual' || sides.size !== 1) return [...MODE_ROLES.manual[0]!.allowedRoles];
  const flow = MODE_FLOW[mode];
  // 自口座が借方なら相手は貸方（source）、自口座が貸方なら相手は借方（destination）。
  return [...sides][0] === 'debit'
    ? [...flow.source.allowedRoles]
    : [...flow.destination.allowedRoles];
}

/** 一括確認の仕訳形表示（自口座側で 借方/貸方 が分かれ得るため両方数える）。 */
function bulkShapeLines(
  rows: readonly ReviewRow[],
  ownName: string,
  counterName: string,
): string[] {
  const lines: string[] = [];
  for (const side of ['debit', 'credit'] as const) {
    const count = rows.filter((r) => r.row.ownSide === side).length;
    if (count === 0) continue;
    lines.push(
      t('csvImport.bulkShapeLine', {
        debit: side === 'debit' ? ownName : counterName,
        credit: side === 'debit' ? counterName : ownName,
        count,
      }),
    );
  }
  return lines;
}

/* ── メイン画面 ── */

export function CsvImport({ onOpenEntry }: { onOpenEntry: (entryId: string) => void }) {
  const { ledger, applyCsvImportBatch, removeCsvImportDecisions } = useLedger();
  const fileRef = useRef<HTMLInputElement>(null);
  // レビュー素材（パース・評価・ハッシュ）のキャッシュ（項目8）。computeReview が所有する。
  const reviewSourceCache = useRef<ReviewSourceCache | null>(null);
  // ファイル読込のレースガード（P1-3）: 新しい選択が始まったら古い非同期読込の結果を捨てる。
  const fileReadToken = useRef(0);

  const [tab, setTab] = useState<'flow' | 'decisions' | 'profiles'>('flow');
  const [fileData, setFileData] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [profileId, setProfileId] = useState('');
  const [bindingChoice, setBindingChoice] = useState('');
  const [builtReview, setBuiltReview] = useState<ReviewState | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rebuildTick, setRebuildTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showSkipDetail, setShowSkipDetail] = useState(false);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  // シート・ダイアログ
  const [setupState, setSetupState] = useState<{ existing: ProfileBinding | null } | null>(null);
  // 「以前の取込と同一の可能性」行のうちユーザーがスキップを確定した rowKey（P1-1）。
  // 決定は保存済みなので何も書かない = ファイルを替えたらリセットするセッション内の確認記録。
  const [priorConfirmedKeys, setPriorConfirmedKeys] = useState<ReadonlySet<string>>(new Set());
  const [bulkKind, setBulkKind] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<ReviewRow | null>(null);
  const [linkTarget, setLinkTarget] = useState<ReviewRow | null>(null);
  // 決定済み一覧のフィルター・解除確認
  const [decisionProfileFilter, setDecisionProfileFilter] = useState('');
  const [decisionFileFilter, setDecisionFileFilter] = useState('');
  const [decisionStatusFilter, setDecisionStatusFilter] = useState<'all' | ImportDecisionStatus>(
    'all',
  );
  const [pendingRemove, setPendingRemove] = useState<ImportDecision | null>(null);
  // ファイル絞り込みの表示材料（fileHash → 取込日・総行数）。決定済みタブでだけ読む。
  const [fileRecords, setFileRecords] = useState<Record<string, ImportFileRecord>>({});

  const accounts = useMemo(() => ledger?.accounts ?? [], [ledger]);
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const entriesById = useMemo(
    () => new Map((ledger?.journalEntries ?? []).map((e) => [e.id, e])),
    [ledger],
  );
  const currency = ledger?.settings.currency ?? 'JPY';
  const profiles = useMemo(() => ledger?.importProfiles ?? [], [ledger]);
  // 取込に使えるのは非アーカイブのみ（アーカイブ済みは一覧の区別表示と decision の
  // provenance 参照にだけ残る・作者決定 2026-08-11）。決定済み一覧のラベルは全件から引く。
  const activeProfiles = useMemo(() => profiles.filter((p) => p.archived !== true), [profiles]);
  const profile = activeProfiles.find((p) => p.id === profileId);
  const bindings = useMemo(
    () => (ledger?.profileBindings ?? []).filter((b) => b.profileId === profileId),
    [ledger, profileId],
  );
  // 取込元の選択は「明示選択が生きていればそれ・でなければ先頭」を描画時に導出する
  // （effect での setState を避ける。profile 切替で自動的に追随する）。
  const binding = bindings.find((b) => b.id === bindingChoice) ?? bindings[0];
  const bindingId = binding?.id ?? '';
  const bindingBroken = binding !== undefined && bindingIsBroken(binding, accountsById);

  // レビューの組み立て（ファイル・profile・binding が揃ったときだけ）。適用・解除の後は
  // rebuildTick で作り直す（decision と台帳世代の同期・§4 手順 4「残件表示を更新」）。
  // busy の解除もここで行う（項目7）: 適用側は busy を立てたままにし、再構築が終わった
  // 描画と同時に解く。旧実装（適用完了で即解除）は「古いレビューのままボタンだけ生きる」
  // 窓を作り、次の適用が stale な ledgerVersion で全拒否されて無駄になっていた。
  useEffect(() => {
    // 選択が崩れている間は何もしない（busy が立っていても、review = null で busy に
    // 依存する操作は描画されない。選択が復帰すれば下の finally が必ず解除する）。
    if (!fileData || !profile || !binding || bindingBroken) return;
    let active = true;
    (async () => {
      try {
        const next = await computeReview(fileData, profile.id, binding.id, reviewSourceCache);
        if (active) {
          setBuiltReview(next);
          setFileError(null);
        }
      } catch (e) {
        if (active) {
          setBuiltReview(null);
          setFileError(errorText(e));
        }
      } finally {
        // setBuiltReview と同一バッチで解除する = ボタン活性と新レビューが同時に出る。
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileData, profile?.id, binding?.id, bindingBroken, rebuildTick]);

  // 選択（ファイル・profile・取込元）と一致しない古いレビューは表示しない（リセットは
  // effect ではなく描画時の整合判定で行う）。
  const review =
    builtReview !== null &&
    fileData !== null &&
    builtReview.file === fileData &&
    profile !== undefined &&
    builtReview.profileId === profile.id &&
    builtReview.bindingId === bindingId &&
    !bindingBroken
      ? builtReview
      : null;

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // レースガード（P1-3）: 選択の**開始時点**で旧レビューを無効化する。読込完了を待って
    // から切り替えると、A 読込中に B を選んだとき古い応答が新しい選択を上書きしたり、
    // 旧ファイルのレビューのまま適用できる窓が残る。読込失敗時も旧状態には戻らない
    // （fileData = null のまま明示エラーを表示する）。
    const token = ++fileReadToken.current;
    setFileData(null);
    setBuiltReview(null);
    setFileError(null);
    setShowSkipDetail(false);
    setShowErrorDetail(false);
    setPriorConfirmedKeys(new Set());
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (fileReadToken.current !== token) return; // 新しい選択が始まっている = 古い応答を捨てる
      setFileData({ name: file.name, bytes });
    } catch {
      if (fileReadToken.current !== token) return;
      setFileError(t('csvImport.readFailed'));
    }
  }

  /**
   * 一括適用・個別適用・リンク・無視の共通経路。成功／失敗のどちらでもレビューを作り直す。
   * 失敗は再 throw する（toast は store が出し済み。EntrySheet 再利用の行編集が
   * シートを開いたままにする判断に使う）。bindingUpdate は一括適用の「既定にする」学習
   * （適用と同一 tx・§4-4）。
   */
  async function runApplyOrThrow(actions: ImportBatchAction[], bindingUpdate?: ProfileBinding) {
    if (!review || busy || actions.length === 0) return;
    setBusy(true);
    try {
      await applyCsvImportBatch({
        profileId: review.profileId,
        profileDigest: review.profileDigest,
        bindingId: review.bindingId,
        fileHash: review.fileHash,
        fileTotalRowCount: review.evaluation.totalRowCount,
        actions,
        ...(bindingUpdate !== undefined ? { bindingUpdate } : {}),
        expectedLedgerVersion: review.ledgerVersion,
      });
    } finally {
      // busy はここで解かない（項目7）: レビュー再構築（上の effect）が完了するまで
      // 維持し、古い ledgerVersion のまま次の適用ができる stale 窓を作らない。
      setRebuildTick((n) => n + 1);
    }
  }

  async function runApply(actions: ImportBatchAction[], bindingUpdate?: ProfileBinding) {
    try {
      await runApplyOrThrow(actions, bindingUpdate);
    } catch {
      // store が toast 済み。stale / alreadyDecided もレビュー作り直しで回復する。
    }
  }

  /**
   * dangling 決定の明示解除（§1-2）。自動では絶対に消さない — このボタンだけが
   * removeCsvImportDecisions（store 経由 = toast + React 側一覧の更新）を呼び、
   * 解除後にレビューを作り直して行を普通の未解決へ戻す。
   */
  async function releaseDanglingDecision(rowKey: string) {
    if (busy) return;
    setBusy(true);
    try {
      await removeCsvImportDecisions([rowKey]);
    } catch {
      // store が toast 済み。作り直しで現状と同期する。
    } finally {
      // busy の解除はレビュー再構築の完了時（effect 側・項目7）。
      setRebuildTick((n) => n + 1);
    }
  }

  /** ワンタップ適用・一括適用の register action（自口座を行の借/貸側・相手側 = 計上先）。 */
  function registerAction(row: NormalizedRow, counterAccountId: string): ImportBatchAction {
    const own = review!.ownAccountId;
    const entry = buildSimpleEntry({
      date: row.date,
      description: row.description || row.kind,
      debitAccountId: row.ownSide === 'debit' ? own : counterAccountId,
      creditAccountId: row.ownSide === 'debit' ? counterAccountId : own,
      amount: row.amount,
    });
    return { kind: 'register', rowKey: row.rowKey, entry };
  }

  /* ── 派生ビュー ── */

  const groups =
    review && profile && binding
      ? unresolvedGroups(review, profile, binding, priorConfirmedKeys)
      : [];
  const remaining = groups.reduce((sum, g) => sum + g.rows.length, 0);
  // 決定済み = 決定的スキップ + このセッションでスキップを確定した「同一の可能性」行。
  const decidedCount = review
    ? review.resolutions.filter(
        (r) =>
          r.status === 'decided' ||
          (r.status === 'unresolved-prior-decision' && priorConfirmedKeys.has(r.rowKey)),
      ).length
    : 0;
  const skipCounts = useMemo(() => {
    const map = new Map<ImportRowSkipCode, number>();
    for (const s of review?.evaluation.skipped ?? []) {
      map.set(s.reasonCode, (map.get(s.reasonCode) ?? 0) + 1);
    }
    return map;
  }, [review]);

  const accountName = (id: string | undefined): string =>
    id !== undefined ? (accountsById.get(id)?.name ?? '—') : '—';

  /* ── 決定済み一覧（§4-6） ── */

  const allDecisions = useMemo(() => ledger?.importDecisions ?? [], [ledger]);
  // ファイル絞り込みの表示材料（項目3）。決定が変わり得るたび（ledger 更新）に読み直す。
  // 読めなくても絞り込み自体は fileHash で機能する（表示がハッシュ表記になるだけ）。
  useEffect(() => {
    if (tab !== 'decisions') return;
    let active = true;
    getImportFileRecords()
      .then((records) => {
        if (active) setFileRecords(records);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [tab, ledger]);
  // 決定の取込元表示名は sourceId から現在の binding を引く（表示名は編集可能・監査 P1-3）。
  const sourceNameById = useMemo(
    () => new Map((ledger?.profileBindings ?? []).map((b) => [b.sourceId, b.sourceIdentity])),
    [ledger],
  );
  const decisionProfileOptions = useMemo(() => {
    const ids = new Set(allDecisions.map((d) => d.provenance.profileId));
    return [...ids].map((id) => ({
      value: id,
      label: profiles.find((p) => p.id === id)?.name ?? id,
    }));
  }, [allDecisions, profiles]);
  // ファイル絞り込み（項目3）: キーは provenance.fileHash・表示はファイル記録の情報
  // （取込日・総行数）+ ハッシュ先頭。記録が無い（読めない）ハッシュはハッシュ表記で出す。
  const decisionFileOptions = useMemo(() => {
    const hashes = new Set(allDecisions.map((d) => d.provenance.fileHash));
    return [...hashes].map((hash) => {
      const record = fileRecords[hash];
      return {
        value: hash,
        label:
          record !== undefined
            ? t('csvImport.decisionsFileOption', {
                date: record.importedAt.slice(0, 10),
                total: record.totalRowCount,
                hash: hash.slice(0, 8),
              })
            : t('csvImport.decisionsFileUnknown', { hash: hash.slice(0, 8) }),
      };
    });
  }, [allDecisions, fileRecords]);
  const filteredDecisions = allDecisions
    .filter((d) => decisionProfileFilter === '' || d.provenance.profileId === decisionProfileFilter)
    .filter((d) => decisionFileFilter === '' || d.provenance.fileHash === decisionFileFilter)
    .filter((d) => decisionStatusFilter === 'all' || d.status === decisionStatusFilter)
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0));

  return (
    /* csv-import クラスは app.css の Segmented 44px 上書き（項目4）のスコープ。 */
    <section className="csv-import" aria-labelledby="csv-import-title" data-ui={UI.csvImport.view}>
      <h1 className="screen-title" id="csv-import-title">
        {t('csvImport.title')}
      </h1>

      <div className="toolbar">
        <Segmented
          value={tab}
          items={[
            { key: 'flow', label: t('csvImport.tabFlow'), dataUi: UI.csvImport.tabFlow },
            {
              key: 'decisions',
              label: t('csvImport.tabDecisions'),
              dataUi: UI.csvImport.tabDecisions,
            },
            {
              key: 'profiles',
              label: t('csvImport.tabProfiles'),
              dataUi: UI.csvImport.tabProfiles,
            },
          ]}
          onChange={(key) => setTab(key === 'decisions' || key === 'profiles' ? key : 'flow')}
        />
      </div>

      {tab === 'flow' ? (
        <>
          {/* 入力: ファイル + profile + 取込元 */}
          <div className="card card--pad stack">
            <p className="field__hint">{t('csvImport.intro')}</p>
            <div>
              <p className="section-label">{t('csvImport.fileLabel')}</p>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  data-ui={UI.csvImport.filePick}
                >
                  <Icon name="upload" size={18} />
                  {t('csvImport.filePick')}
                </button>
                <span className="muted" style={{ fontSize: 13 }}>
                  {fileData ? fileData.name : t('csvImport.fileNone')}
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
                data-ui={UI.csvImport.fileInput}
              />
            </div>
            {activeProfiles.length === 0 ? (
              <p className="field__hint">{t('csvImport.noProfiles')}</p>
            ) : (
              <SelectInput
                label={t('csvImport.profileLabel')}
                value={profileId}
                onChange={setProfileId}
                placeholder={t('csvImport.profilePlaceholder')}
                options={activeProfiles.map((p) => ({ value: p.id, label: p.name }))}
                dataUi={UI.csvImport.profile}
              />
            )}
            {/* ID 列の無い profile の注意（P1-1）: fp キーの重複は自動確定されない。 */}
            {profile && profile.dsl.externalId === undefined ? (
              <p className="field__hint" data-ui={UI.csvImport.noIdNote}>
                {t('csvImport.noIdNote')}
              </p>
            ) : null}
            {profile && bindings.length > 0 ? (
              <div>
                <SelectInput
                  label={t('csvImport.sourceLabel')}
                  value={bindingId}
                  onChange={setBindingChoice}
                  options={bindings.map((b) => ({ value: b.id, label: b.sourceIdentity }))}
                  dataUi={UI.csvImport.source}
                />
                <div className="toolbar" style={{ marginTop: 6 }}>
                  {binding ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setSetupState({ existing: binding })}
                      data-ui={UI.csvImport.sourceEdit}
                    >
                      <Icon name="edit" size={16} />
                      {t('csvImport.sourceEdit')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setSetupState({ existing: null })}
                    data-ui={UI.csvImport.sourceAdd}
                  >
                    <Icon name="add" size={16} />
                    {t('csvImport.sourceAdd')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* binding 未設定 / 壊れの gate（fail-closed・§1-1b） */}
          {profile && bindings.length === 0 ? (
            <div className="card card--pad stack">
              <p className="field__hint">{t('csvImport.setupNeeded')}</p>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => setSetupState({ existing: null })}
                data-ui={UI.csvImport.setupOpen}
              >
                {t('csvImport.setupOpen')}
              </button>
            </div>
          ) : null}
          {bindingBroken && binding ? (
            <div className="card card--pad stack" role="alert">
              <p className="field__hint">{t('csvImport.bindingBroken')}</p>
              <button
                type="button"
                className="btn btn--block"
                onClick={() => setSetupState({ existing: binding })}
              >
                {t('csvImport.sourceEdit')}
              </button>
            </div>
          ) : null}

          {fileError !== null ? (
            <div className="card card--pad" role="alert">
              <p className="field__error" style={{ display: 'flex', gap: 6 }}>
                <Icon name="alert" size={16} />
                {fileError}
              </p>
            </div>
          ) : null}

          {/* 件数会計（§4-2 の保存則を常時表示） */}
          {review ? (
            <div className="card card--pad" data-ui={UI.csvImport.counts}>
              <p className="section-label">{t('csvImport.countsTitle')}</p>
              <div className="kv">
                <span className="muted">{t('csvImport.rowsTotal')}</span>
                <span>{review.evaluation.totalRowCount}</span>
              </div>
              <div className="kv">
                <span className="muted">{t('csvImport.rowsTarget')}</span>
                <span>{review.rows.length}</span>
              </div>
              <div className="kv">
                <span className="muted">{t('csvImport.rowsSkipped')}</span>
                <span>{review.evaluation.skipped.length}</span>
              </div>
              <div className="kv">
                <span className="muted">{t('csvImport.rowsError')}</span>
                <span>{review.evaluation.errors.length}</span>
              </div>
              {decidedCount > 0 ? (
                <p className="field__hint" style={{ marginTop: 6 }}>
                  {t('csvImport.decidedNote', { decided: decidedCount, remaining })}
                </p>
              ) : null}
              {review.fileRecord !== undefined ? (
                <p
                  className="field__hint"
                  style={{ marginTop: 6 }}
                  data-ui={UI.csvImport.fileRecord}
                >
                  {t('csvImport.fileRecord', {
                    decided: review.fileRecord.decidedCount,
                    total: review.fileRecord.totalRowCount,
                    date: review.fileRecord.importedAt.slice(0, 10),
                  })}
                </p>
              ) : null}
              {review.evaluation.skipped.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-expanded={showSkipDetail}
                    onClick={() => setShowSkipDetail((v) => !v)}
                    data-ui={UI.csvImport.skipToggle}
                  >
                    <Icon name="expand" size={16} />
                    {t('csvImport.skipToggle')}
                  </button>
                  {showSkipDetail ? (
                    <ul className="list" data-ui={UI.csvImport.skipList}>
                      {[...skipCounts].map(([code, count]) => (
                        <li key={code} className="list__item">
                          <div className="list__main">
                            <div className="list__title">{skipReasonLabel(code)}</div>
                          </div>
                          <span className="list__amount">
                            {t('csvImport.kindCount', { count })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {review.evaluation.errors.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    aria-expanded={showErrorDetail}
                    onClick={() => setShowErrorDetail((v) => !v)}
                    data-ui={UI.csvImport.errorToggle}
                  >
                    <Icon name="alert" size={16} />
                    {t('csvImport.errorToggle')}
                  </button>
                  {showErrorDetail ? (
                    <ul className="list" data-ui={UI.csvImport.errorList}>
                      {review.evaluation.errors.map((err) => (
                        <li key={`${err.rowIndex}-${err.reasonCode}`} className="list__item">
                          <div className="list__main">
                            <div className="list__title">{rowErrorLabel(err.reasonCode)}</div>
                            <div className="list__sub">
                              {t('csvImport.rowLine', { line: err.rowIndex })}
                              {err.detail !== undefined ? `・${err.detail}` : ''}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* レビューキュー / 完了 */}
          {review && review.rows.length === 0 ? (
            <div className="card card--pad empty">{t('csvImport.reviewNoRows')}</div>
          ) : null}
          {review && review.rows.length > 0 && remaining === 0 ? (
            review.evaluation.errors.length === 0 ? (
              <div className="card card--pad" data-ui={UI.csvImport.complete}>
                <p className="section-label">
                  <Icon name="check" size={16} /> {t('csvImport.reviewComplete')}
                </p>
                <p className="field__hint">
                  {t('csvImport.reviewCompleteBody', { count: review.rows.length })}
                </p>
              </div>
            ) : (
              /* エラー行が残っている間は「取込完了」と言わない（項目1）。error 行は
                 この profile では取り込まれない事実（fail-closed）をここでも可視化する。 */
              <div className="card card--pad" role="status" data-ui={UI.csvImport.completeErrors}>
                <p className="section-label" style={{ display: 'flex', gap: 6 }}>
                  <Icon name="alert" size={16} /> {t('csvImport.reviewErrorsRemain')}
                </p>
                <p className="field__hint">
                  {t('csvImport.reviewErrorsRemainBody', {
                    decided: review.rows.length,
                    count: review.evaluation.errors.length,
                  })}
                </p>
              </div>
            )
          ) : null}
          {review && remaining > 0 ? (
            <div data-ui={UI.csvImport.reviewList}>
              <p className="section-label">{t('csvImport.reviewTitle', { count: remaining })}</p>
              {groups.map((group) => {
                const bulkRows = bulkApplicableRows(group.rows);
                return (
                  <div className="card" data-ui={UI.csvImport.kindGroup} key={group.kind}>
                    <div
                      className="toolbar"
                      style={{ padding: 'var(--space-3)', justifyContent: 'space-between' }}
                    >
                      <span>
                        <strong>{group.kind}</strong>{' '}
                        <span className="muted" style={{ fontSize: 13 }}>
                          {t('csvImport.kindCount', { count: group.rows.length })}
                        </span>
                      </span>
                      {bulkRows.length > 0 ? (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={busy}
                          onClick={() => setBulkKind(group.kind)}
                          data-ui={UI.csvImport.kindBulk}
                        >
                          <Icon name="check" size={16} />
                          {t('csvImport.bulkApply')}
                        </button>
                      ) : null}
                    </div>
                    <ul className="list">
                      {group.rows.map((r) =>
                        r.resolution.status === 'unresolved-prior-decision' ? (
                          /* 別ファイル由来の決定にヒットした fp 行（P1-1）: 黙ってスキップせず
                             提示し、既定の提案 = スキップをユーザーが確定する。決定は保存済みの
                             ため何も書かない（適用/リンク/無視は alreadyDecided になるので出さない）。 */
                          <li key={r.row.rowKey} className="list__item" data-ui={UI.csvImport.row}>
                            <div className="list__main">
                              <div className="list__title">
                                <span className="tag tag--warning">{t('csvImport.priorTag')}</span>{' '}
                                {r.row.description || r.row.kind}
                              </div>
                              <div className="list__sub">
                                {r.row.date}・{t('csvImport.priorNote')}
                              </div>
                            </div>
                            <span className="list__amount">
                              <Money amount={r.row.amount} currency={currency} />
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={busy}
                              onClick={() =>
                                setPriorConfirmedKeys((prev) => new Set([...prev, r.row.rowKey]))
                              }
                              aria-label={`${t('csvImport.priorSkip')}: ${
                                r.row.description || r.row.kind
                              }`}
                              data-ui={UI.csvImport.rowPriorSkip}
                            >
                              {t('csvImport.priorSkip')}
                            </button>
                          </li>
                        ) : r.resolution.status === 'unresolved-dangling' ? (
                          /* dangling（§1-2）: 参照先仕訳が無い決定。自動削除せず、明示解除
                             するまで適用・リンク・無視のどれもできない（fail-closed）。 */
                          <li key={r.row.rowKey} className="list__item" data-ui={UI.csvImport.row}>
                            <div className="list__main">
                              <div className="list__title">
                                <span className="tag tag--warning">
                                  {t('csvImport.rowFlagged')}
                                </span>{' '}
                                {r.row.description || r.row.kind}
                              </div>
                              <div className="list__sub">
                                {r.row.date}・{t('csvImport.danglingNote')}
                              </div>
                            </div>
                            <span className="list__amount">
                              <Money amount={r.row.amount} currency={currency} />
                            </span>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={busy}
                              onClick={() => void releaseDanglingDecision(r.row.rowKey)}
                              aria-label={`${t('csvImport.danglingRelease')}: ${
                                r.row.description || r.row.kind
                              }`}
                              data-ui={UI.csvImport.rowRelease}
                            >
                              {t('csvImport.danglingRelease')}
                            </button>
                          </li>
                        ) : (
                          <li key={r.row.rowKey} className="list__item" data-ui={UI.csvImport.row}>
                            <button
                              type="button"
                              className="list__main"
                              style={{
                                background: 'transparent',
                                border: 'none',
                                textAlign: 'left',
                              }}
                              onClick={() => setApplyTarget(r)}
                              aria-label={`${t('csvImport.rowNeedsAccount')}: ${
                                r.row.description || r.row.kind
                              }`}
                            >
                              <div className="list__title">{r.row.description || r.row.kind}</div>
                              <div className="list__sub">
                                {r.row.date}
                                {r.defaultCounterId !== undefined
                                  ? `・${accountName(r.defaultCounterId)}`
                                  : ''}
                              </div>
                            </button>
                            <span className="list__amount">
                              <Money amount={r.row.amount} currency={currency} />
                            </span>
                            {r.defaultCounterId !== undefined ? (
                              <button
                                type="button"
                                className="icon-btn"
                                disabled={busy}
                                onClick={() =>
                                  runApply([registerAction(r.row, r.defaultCounterId!)])
                                }
                                aria-label={`${t('csvImport.rowApply')}: ${
                                  r.row.description || r.row.kind
                                }`}
                                data-ui={UI.csvImport.rowApply}
                              >
                                <Icon name="check" size={18} />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={busy}
                              onClick={() => setLinkTarget(r)}
                              aria-label={`${t('csvImport.rowLink')}: ${
                                r.row.description || r.row.kind
                              }`}
                              data-ui={UI.csvImport.rowLink}
                            >
                              <Icon name="transfer" size={18} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={busy}
                              onClick={() => runApply([{ kind: 'ignore', rowKey: r.row.rowKey }])}
                              aria-label={`${t('csvImport.rowIgnore')}: ${
                                r.row.description || r.row.kind
                              }`}
                              data-ui={UI.csvImport.rowIgnore}
                            >
                              <Icon name="close" size={18} />
                            </button>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : tab === 'profiles' ? (
        /* プロファイル管理 + AI ビルダー（§1-1 / §6・別ファイル） */
        <CsvImportProfiles
          onContinueToImport={(newProfileId, file) => {
            // ビルダー保存後の導線（§6-6）: 保存した profile と選択済みファイルで
            // 通常の取込フローへ（binding 未設定ならセットアップシートの gate が出る）。
            // 進行中のファイル読込があれば無効化する（P1-3 のレースガードと同じ token）。
            fileReadToken.current += 1;
            setTab('flow');
            setProfileId(newProfileId);
            setBindingChoice('');
            setBuiltReview(null);
            setFileError(null);
            setShowSkipDetail(false);
            setShowErrorDetail(false);
            setPriorConfirmedKeys(new Set());
            setFileData(file);
          }}
        />
      ) : (
        /* 決定済み一覧（§4-6） */
        <>
          <div className="toolbar">
            {decisionProfileOptions.length > 0 ? (
              <select
                className="select"
                value={decisionProfileFilter}
                aria-label={t('csvImport.decisionsProfileLabel')}
                onChange={(e) => setDecisionProfileFilter(e.target.value)}
                data-ui={UI.csvImport.decisionsProfile}
              >
                <option value="">{t('csvImport.decisionsAllProfiles')}</option>
                {decisionProfileOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
            {decisionFileOptions.length > 0 ? (
              <select
                className="select"
                value={decisionFileFilter}
                aria-label={t('csvImport.decisionsFileLabel')}
                onChange={(e) => setDecisionFileFilter(e.target.value)}
                data-ui={UI.csvImport.decisionsFile}
              >
                <option value="">{t('csvImport.decisionsAllFiles')}</option>
                {decisionFileOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
            <Segmented
              value={decisionStatusFilter}
              items={[
                { key: 'all', label: t('csvImport.statusAll'), dataUi: UI.csvImport.statusAll },
                {
                  key: 'registered',
                  label: statusLabel('registered'),
                  dataUi: UI.csvImport.statusRegistered,
                },
                { key: 'linked', label: statusLabel('linked'), dataUi: UI.csvImport.statusLinked },
                {
                  key: 'ignored',
                  label: statusLabel('ignored'),
                  dataUi: UI.csvImport.statusIgnored,
                },
              ]}
              onChange={(key) =>
                setDecisionStatusFilter(
                  key === 'registered' || key === 'linked' || key === 'ignored' ? key : 'all',
                )
              }
            />
          </div>
          <p className="field__hint" style={{ marginBottom: 8 }}>
            {t('csvImport.registeredRemoveHint')}
          </p>
          {filteredDecisions.length === 0 ? (
            <div className="card card--pad empty">{t('csvImport.decisionsEmpty')}</div>
          ) : (
            <ul className="card list" data-ui={UI.csvImport.decisionsList}>
              {filteredDecisions.map((d) => {
                const entry = d.entryId !== undefined ? entriesById.get(d.entryId) : undefined;
                return (
                  <li key={d.key} className="list__item" data-ui={UI.csvImport.decisionRow}>
                    <div className="list__main">
                      <div className="list__title">
                        <span
                          className={`tag ${d.status === 'ignored' ? 'tag--neutral' : 'tag--teal'}`}
                        >
                          {statusLabel(d.status)}
                        </span>{' '}
                        {readableRowKey(d.key)}
                      </div>
                      <div className="list__sub">
                        {sourceNameById.get(d.provenance.sourceId) ??
                          t('csvImport.decisionSourceUnknown')}
                        ・{d.decidedAt.slice(0, 10)}
                        {d.entryId !== undefined
                          ? `・${entry?.description ?? t('csvImport.decisionEntryMissing')}`
                          : ''}
                      </div>
                    </div>
                    {entry !== undefined ? (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => onOpenEntry(entry.id)}
                        data-ui={UI.csvImport.decisionOpenEntry}
                      >
                        {t('csvImport.openEntry')}
                      </button>
                    ) : null}
                    {d.status === 'linked' || d.status === 'ignored' ? (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setPendingRemove(d)}
                        aria-label={`${t('csvImport.removeDecision')}: ${readableRowKey(d.key)}`}
                        data-ui={UI.csvImport.decisionRemove}
                      >
                        <Icon name="restore" size={18} />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* binding セットアップ（§1-1b） */}
      {setupState && profile ? (
        <BindingSetupSheet
          profile={profile}
          accounts={accounts}
          existing={setupState.existing}
          onClose={() => setSetupState(null)}
          onSaved={(saved) => {
            setSetupState(null);
            setBindingChoice(saved.id);
            setRebuildTick((n) => n + 1);
          }}
        />
      ) : null}

      {/* 一括適用（計上先の選択 + 対象件数と仕訳形・§4 手順 4・監査 P1-4） */}
      {bulkKind !== null && review && profile && binding ? (
        <BulkApplySheet
          kind={bulkKind}
          rows={bulkApplicableRows(groups.find((g) => g.kind === bulkKind)?.rows ?? [])}
          profile={profile}
          binding={binding}
          accounts={accounts}
          ownAccountId={review.ownAccountId}
          busy={busy}
          onClose={() => setBulkKind(null)}
          onApply={async (counterAccountId, learnDefault) => {
            const rows = bulkApplicableRows(groups.find((g) => g.kind === bulkKind)?.rows ?? []);
            const kind = bulkKind;
            setBulkKind(null);
            // 「既定にする」学習は binding の行種→計上先へ（適用と同一 tx・保存境界が
            // role 整合と sourceId 不変を再検証する）。
            const bindingUpdate = learnDefault
              ? {
                  ...binding,
                  kindDestinations: { ...binding.kindDestinations, [kind]: counterAccountId },
                  updatedAt: nowIso(),
                }
              : undefined;
            // 日付昇順で適用する（表示・監査のしやすさのための整形。§A で暗黙開始日が
            // 廃止されたため順序依存はもう無い — どの順でも保存結果は同じ）。
            const ordered = [...rows].sort((a, b) => a.row.date.localeCompare(b.row.date));
            await runApply(
              ordered.map((r) => registerAction(r.row, counterAccountId)),
              bindingUpdate,
            );
          }}
        />
      ) : null}

      {/* 個別行の「編集して適用」= ホームの仕訳入力シートの再利用（監査 P1-2）。
          候補・検証は通常入力と同一。保存だけ register action（仕訳 + decision の同一 tx）
          へ流れ、失敗時はシートが開いたまま（toast は store）。 */}
      {applyTarget && review && profile ? (
        <EntrySheet
          init={{
            kind: 'import',
            context: {
              mode: formModeForRow(profile, applyTarget.row),
              input: importEntryInput(applyTarget, review.ownAccountId),
              onSave: async (input) => {
                await runApplyOrThrow([
                  {
                    kind: 'register',
                    rowKey: applyTarget.row.rowKey,
                    entry: buildSimpleEntry(input),
                  },
                ]);
              },
            },
          }}
          onClose={() => setApplyTarget(null)}
        />
      ) : null}

      {/* 既存仕訳へのリンク（類似候補は提示のみ・§5-2 層2） */}
      {linkTarget && review ? (
        <LinkSheet
          reviewRow={linkTarget}
          entriesById={entriesById}
          entries={ledger?.journalEntries ?? []}
          accountsById={accountsById}
          currency={currency}
          busy={busy}
          onClose={() => setLinkTarget(null)}
          onLink={async (entryId) => {
            const target = linkTarget;
            setLinkTarget(null);
            await runApply([{ kind: 'link', rowKey: target.row.rowKey, entryId }]);
          }}
        />
      ) : null}

      {/* 決定の解除（確認 1 つ・冪等・§4-6） */}
      {pendingRemove ? (
        <ConfirmDialog
          title={
            pendingRemove.status === 'ignored'
              ? t('csvImport.removeConfirmTitle.ignored')
              : t('csvImport.removeConfirmTitle.linked')
          }
          body={
            pendingRemove.status === 'ignored'
              ? t('csvImport.removeConfirmBody.ignored')
              : t('csvImport.removeConfirmBody.linked')
          }
          confirmLabel={t('csvImport.removeDecision')}
          danger
          dataUi={UI.csvImport.removeConfirm}
          onCancel={() => setPendingRemove(null)}
          onConfirm={async () => {
            const target = pendingRemove;
            setPendingRemove(null);
            await removeCsvImportDecisions([target.key]).catch(() => undefined);
            setRebuildTick((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

/* ── binding セットアップシート（§1-1b・明示選択・サジェストは自動確定しない） ── */

const INCOME_SUGGEST_NAME = 'その他収入';

function BindingSetupSheet({
  profile,
  accounts,
  existing,
  onClose,
  onSaved,
}: {
  profile: ImportProfile;
  accounts: Account[];
  existing: ProfileBinding | null;
  onClose: () => void;
  onSaved: (saved: ProfileBinding) => void;
}) {
  const { saveProfileBinding } = useLedger();
  const isPaypay = profile.builtin?.builtinId === PAYPAY_BUILTIN_ID;
  const existingIncome = existing
    ? (PAYPAY_INCOME_KINDS.map((k) => existing.kindDestinations[k]).find((v) => v !== undefined) ??
      '')
    : '';

  const [identity, setIdentity] = useState(existing?.sourceIdentity ?? '');
  const [ownAccountId, setOwnAccountId] = useState(existing?.ownAccountId ?? '');
  const [incomeAccountId, setIncomeAccountId] = useState(existingIncome);
  const [chargeAccountId, setChargeAccountId] = useState(existing?.chargeSourceAccountId ?? '');
  // 取込開始日（§B・任意）。空欄 = 未設定 = 全期間。
  const [importFromDate, setImportFromDate] = useState(existing?.importFromDate ?? '');
  const [submitting, setSubmitting] = useState(false);

  const dirty =
    identity !== (existing?.sourceIdentity ?? '') ||
    ownAccountId !== (existing?.ownAccountId ?? '') ||
    incomeAccountId !== existingIncome ||
    chargeAccountId !== (existing?.chargeSourceAccountId ?? '') ||
    importFromDate !== (existing?.importFromDate ?? '');
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  const suggestAccount = accounts.find(
    (a) => a.role === 'income-category' && !a.archived && a.name === INCOME_SUGGEST_NAME,
  );
  // 同一科目の借貸両側は拒否（§1-1b。保存境界でも検証されるが、入口で見せて止める）。
  const chargeSameAsOwn = chargeAccountId !== '' && chargeAccountId === ownAccountId;
  const incomeSameAsOwn = incomeAccountId !== '' && incomeAccountId === ownAccountId;
  const valid =
    identity.trim() !== '' &&
    ownAccountId !== '' &&
    !chargeSameAsOwn &&
    !incomeSameAsOwn &&
    (!isPaypay || (incomeAccountId !== '' && chargeAccountId !== ''));

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const kindDestinations = { ...(existing?.kindDestinations ?? {}) };
      if (isPaypay && incomeAccountId !== '') {
        for (const kind of PAYPAY_INCOME_KINDS) kindDestinations[kind] = incomeAccountId;
      }
      const ts = nowIso();
      const binding: ProfileBinding = {
        id: existing?.id ?? newId(),
        profileId: profile.id,
        // 行キーの名前空間は不変の sourceId（作成時に採番・以後変更不可・監査 P1-3）。
        // 表示名 sourceIdentity は編集できる（改名しても過去の決定は照合され続ける）。
        sourceId: existing?.sourceId ?? newId(),
        sourceIdentity: identity.trim(),
        ownAccountId,
        kindDestinations,
        ...(chargeAccountId !== '' ? { chargeSourceAccountId: chargeAccountId } : {}),
        // 空欄 = 未設定（キーごと落とす = 全期間）。設定を消す導線もこの欄の空欄化。
        ...(importFromDate !== '' ? { importFromDate } : {}),
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      const saved = await saveProfileBinding(binding);
      onSaved(saved);
    } catch {
      // store が toast 済み。開いたまま修正できるようにする。
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        title={existing ? t('csvImport.setupEditTitle') : t('csvImport.setupTitle')}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={UI.csvImport.setup}
        footer={
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={submit}
            disabled={!valid || submitting}
            data-ui={UI.csvImport.setupSave}
          >
            {t('csvImport.setupSave')}
          </button>
        }
      >
        <div className="stack">
          <p className="field__hint">{t('csvImport.setupIntro')}</p>
          {/* ID 列の無い profile の注意（P1-1）: fp キーの重複は自動確定されない。 */}
          {profile.dsl.externalId === undefined ? (
            <p className="field__hint" data-ui={UI.csvImport.setupNoIdNote}>
              {t('csvImport.noIdNote')}
            </p>
          ) : null}
          <TextInput
            label={t('csvImport.setupIdentity')}
            value={identity}
            onChange={setIdentity}
            required
            hint={t('csvImport.setupIdentityHint')}
            dataUi={UI.csvImport.setupIdentity}
          />
          <AccountPicker
            label={t('csvImport.setupOwn')}
            groups={groupedAccountsByRole(accounts, ['daily-asset'], ownAccountId || undefined)}
            value={ownAccountId}
            onChange={setOwnAccountId}
            required
            hint={t('csvImport.setupOwnHint')}
            dataUi={UI.csvImport.setupOwn}
          />
          {isPaypay ? (
            <>
              <AccountPicker
                label={t('csvImport.setupIncome')}
                groups={groupedAccountsByRole(
                  accounts,
                  ['income-category'],
                  incomeAccountId || undefined,
                )}
                value={incomeAccountId}
                onChange={setIncomeAccountId}
                required
                hint={t('csvImport.setupIncomeHint')}
                {...(incomeSameAsOwn ? { error: t('csvImport.setupSameAccount') } : {})}
                dataUi={UI.csvImport.setupIncome}
              />
              {suggestAccount && incomeAccountId === '' ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setIncomeAccountId(suggestAccount.id)}
                  data-ui={UI.csvImport.setupIncomeSuggest}
                >
                  {t('csvImport.setupSuggest', { name: suggestAccount.name })}
                </button>
              ) : null}
              <AccountPicker
                label={t('csvImport.setupCharge')}
                groups={groupedAccountsByRole(
                  accounts,
                  ['daily-asset'],
                  chargeAccountId || undefined,
                )}
                value={chargeAccountId}
                onChange={setChargeAccountId}
                required
                hint={t('csvImport.setupChargeHint')}
                {...(chargeSameAsOwn ? { error: t('csvImport.setupSameAccount') } : {})}
                dataUi={UI.csvImport.setupCharge}
              />
            </>
          ) : null}
          {/* 取込開始日（§B・任意）: 評価後の明示 skip。決定を作らないので後から早めれば
              当該行はレビューへ戻る（可逆）。 */}
          <TextInput
            label={t('csvImport.setupImportFrom')}
            type="date"
            value={importFromDate}
            onChange={setImportFromDate}
            hint={t('csvImport.setupImportFromHint')}
            dataUi={UI.csvImport.setupImportFrom}
          />
        </div>
      </Modal>
      {discardConfirm}
    </>
  );
}

/* ── 行種一括適用シート（計上先の選択 + 仕訳形の確認・監査 P1-4） ── */

function BulkApplySheet({
  kind,
  rows,
  profile,
  binding,
  accounts,
  ownAccountId,
  busy,
  onClose,
  onApply,
}: {
  kind: string;
  rows: ReviewRow[];
  profile: ImportProfile;
  binding: ProfileBinding;
  accounts: Account[];
  ownAccountId: string;
  busy: boolean;
  onClose: () => void;
  onApply: (counterAccountId: string, learnDefault: boolean) => Promise<void>;
}) {
  // 初期値 = binding の既定計上先（あれば）。無い行種（支払い等）はここで選ぶ。
  const initialCounterId = defaultCounterFor(profile, binding, kind) ?? '';
  const [counterAccountId, setCounterAccountId] = useState(initialCounterId);
  const [learnDefault, setLearnDefault] = useState(false);

  const dirty = counterAccountId !== initialCounterId || learnDefault;
  const { requestClose, discardConfirm } = useDirtyGuard(dirty, onClose);

  // 自口座と同一の計上先は全行が借貸同一仕訳になる（既存の仕訳入力と同じ規則で拒否）。
  const sameAsOwn = counterAccountId !== '' && counterAccountId === ownAccountId;
  const valid = counterAccountId !== '' && !sameAsOwn;

  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.name ?? '—';
  const counterName =
    counterAccountId === '' ? t('csvImport.bulkCounter') : nameOf(counterAccountId);
  const shapeLines = bulkShapeLines(rows, nameOf(ownAccountId), counterName);

  // 「既定にする」は binding の kindDestinations が受け付ける計上先（自口座以外・
  // 仕訳先にできる通常科目）を選んだときだけ出す（保存境界の role 検証と同じ条件）。
  const canLearn =
    valid && isRecurringPostableRole(accounts.find((a) => a.id === counterAccountId)?.role);

  return (
    <>
      <Modal
        title={t('csvImport.bulkConfirmTitle', { kind })}
        onClose={requestClose}
        dismissMode="if-clean"
        dataUi={UI.csvImport.bulkConfirm}
        footer={
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => {
              if (!valid || busy) return;
              void onApply(counterAccountId, learnDefault && canLearn);
            }}
            disabled={!valid || busy}
            data-ui={UI.csvImport.bulkSave}
          >
            {t('csvImport.bulkApply')}
          </button>
        }
      >
        <div className="stack">
          <AccountPicker
            label={t('csvImport.bulkCounter')}
            groups={groupedAccountsByRole(
              accounts,
              bulkCounterRoles(profile, rows),
              counterAccountId || undefined,
            )}
            value={counterAccountId}
            onChange={setCounterAccountId}
            required
            {...(sameAsOwn ? { error: t('entry.error.same-account') } : {})}
            dataUi={UI.csvImport.bulkCounter}
          />
          {canLearn ? (
            <label
              style={{
                display: 'inline-flex',
                gap: 8,
                alignItems: 'center',
                minHeight: 'var(--tap)',
              }}
            >
              <input
                type="checkbox"
                checked={learnDefault}
                onChange={(e) => setLearnDefault(e.target.checked)}
                data-ui={UI.csvImport.bulkLearn}
              />
              {t('csvImport.bulkLearn', { kind })}
            </label>
          ) : null}
          <p className="field__hint">{shapeLines.join(' ／ ')}</p>
        </div>
      </Modal>
      {discardConfirm}
    </>
  );
}

/* ── 既存仕訳へのリンクシート（類似候補を先頭に提示 + 任意の仕訳検索・§5-2 層2） ── */

const LINK_SEARCH_LIMIT = 20;

function LinkSheet({
  reviewRow,
  entriesById,
  entries,
  accountsById,
  currency,
  busy,
  onClose,
  onLink,
}: {
  reviewRow: ReviewRow;
  entriesById: Map<string, JournalEntry>;
  entries: JournalEntry[];
  accountsById: Map<string, Account>;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onLink: (entryId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const candidates = reviewRow.resolution.similarEntryIds
    .map((id) => entriesById.get(id))
    .filter((e): e is JournalEntry => e !== undefined);
  const candidateIds = new Set(candidates.map((e) => e.id));

  const q = query.trim().toLowerCase();
  const results =
    q === ''
      ? []
      : entries
          .filter((e) => {
            if (candidateIds.has(e.id)) return false;
            const names = e.lines.map((l) => accountsById.get(l.accountId)?.name ?? '').join(' ');
            return `${e.description} ${e.memo ?? ''} ${e.date} ${names}`.toLowerCase().includes(q);
          })
          .slice(0, LINK_SEARCH_LIMIT);

  const entryRow = (entry: JournalEntry, dataUi: string) => {
    const amount = entry.lines.find((l) => l.side === 'debit')?.amount ?? 0;
    return (
      <li key={entry.id} className="list__item">
        <button
          type="button"
          className="list__main"
          style={{ background: 'transparent', border: 'none', textAlign: 'left' }}
          disabled={busy}
          onClick={() => void onLink(entry.id)}
          aria-label={`${t('csvImport.rowLink')}: ${entry.description}`}
          data-ui={dataUi}
        >
          <div className="list__title">{entry.description}</div>
          <div className="list__sub">{entry.date}</div>
        </button>
        <span className="list__amount">
          <Money amount={amount} currency={currency} />
        </span>
      </li>
    );
  };

  return (
    <Modal title={t('csvImport.linkTitle')} onClose={onClose} dataUi={UI.csvImport.linkSheet}>
      <div className="stack">
        <p className="field__hint">{t('csvImport.linkIntro')}</p>
        <div className="kv">
          <span className="muted">{reviewRow.row.date}</span>
          <span>
            {reviewRow.row.description || reviewRow.row.kind}・
            <Money amount={reviewRow.row.amount} currency={currency} />
          </span>
        </div>

        <p className="section-label">{t('csvImport.linkSimilar')}</p>
        {candidates.length === 0 ? (
          <p className="field__hint">{t('csvImport.linkEmpty')}</p>
        ) : (
          <ul className="list">
            {candidates.map((entry) => entryRow(entry, UI.csvImport.linkCandidate))}
          </ul>
        )}

        <TextInput
          label={t('csvImport.linkSearch')}
          value={query}
          onChange={setQuery}
          dataUi={UI.csvImport.linkSearch}
        />
        {q !== '' ? (
          results.length === 0 ? (
            <p className="field__hint">{t('csvImport.linkNoResults')}</p>
          ) : (
            <ul className="list">
              {results.map((entry) => entryRow(entry, UI.csvImport.linkRow))}
            </ul>
          )
        ) : null}
      </div>
    </Modal>
  );
}
