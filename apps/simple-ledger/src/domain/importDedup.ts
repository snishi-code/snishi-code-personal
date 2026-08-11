/*
 * デデュープ層（指示書 §5-2）。**分離可能な独立パーツ**として設計する:
 * 後で照合アルゴリズムを差し替えられるよう、ストレージ・UI・profile に依存しない
 * 純関数だけを置く。呼び出し側（data / UI フェーズ）との契約は次のとおり。
 *
 * 処理順の固定（2026-08-11 明文化・§B で ④ を実装）:
 *   ① 全 valid 行の正規化（importDsl.evaluateProfileText）
 *   ② **全母集合**で rowKey / occurrence 付与（importIdentity.attachRowKeys。
 *      occurrence はファイル内の全行で採番する — 部分集合で振ると番号がずれる）
 *   ③ decision 照合（この層 = resolveImportRows）
 *   ④ 取込開始日 cutoff（この層 = applyImportFromDateCutoff。**未決定かつ
 *      date < importFromDate の行だけ**を理由コード 'before-import-start' の明示 skip へ移す。
 *      決定は作らない = 開始日を早めれば当該行は普通にレビューへ戻る・可逆）
 *   ⑤ invalid 行は隠さず error（件数会計の保存則: 全行 = normalized + skip + error）
 *
 *  入力: rowKey 付きの正規化行の列（ファイル内順。rowKey はファイル内で一意 —
 *        ext キーのファイル内衝突は評価段階で error 行に倒してあり、fp キーは
 *        occurrence 採番で衝突しない）・既存 ImportDecision の Map（rowKey → 要約。
 *        ファイル外の rowKey を含む**全決定**を渡してよい。参照するのは行と同一キーのみ）・
 *        既存仕訳の列（dangling 判定と類似候補の提示用）・レビュー中ファイルの fileHash。
 *  出力: 入力と同順の行別判定。
 *   - 'decided'             = 決定済み（黙って除外してよい行・件数だけ表示）
 *   - 'unresolved'          = 未決定（レビューへ）。同一 fingerprint の決定済み occurrence より
 *                             後の行（部分適用の残り・新しく増えた行）も**普通の未解決**として
 *                             ここに入る。
 *   - 'unresolved-prior-decision' = fingerprint 型キーが**別ファイル由来**の決定にヒットした行。
 *                             黙ってスキップせず「以前の取込と同一の可能性」フラグ付きで
 *                             レビューへ出す（既定の提案 = スキップ・確定はユーザー）。
 *   - 'unresolved-dangling' = 決定はあるが参照先仕訳が実在しない（§1-2）。レビューへ出すが、
 *                             決定の削除は**ユーザーの明示操作**（UI → store 経由）だけが行う。
 *
 *  規則（作者決定 2026-08-11・Codex P1-1 対応）:
 *   - この層は**読み取り専用**の判定器。decision の削除・変更をどの経路でも指示しない。
 *   - **externalId 型キー**は決定的照合（従来どおり decided）。金融口座内で一意な ID が
 *     あるため、部分エクスポート間でも行の同一性が保証される。
 *   - **fingerprint 型キー**の決定済みヒットは、**同一ファイル（決定の由来 fileHash =
 *     レビュー中ファイルの fileHash）の再取込のときだけ**黙って決定的スキップする。
 *     同一バイト列のファイルでは occurrence 採番が完全に一致するため安全。別ファイルでは
 *     部分エクスポート間の occurrence ずれで別の行が同じキーを名乗り得るため、アプリ側で
 *     決定せずレビューへ出す（'unresolved-prior-decision'）。fileHash がどちらか欠けている
 *     場合も同一性を確認できないので fail-closed にレビューへ出す。
 *     旧仕様の「決定済み occurrence 最大値からの既知件数推定（n < k 警告）」はこの単純な
 *     規則に置き換えて撤去した。
 *   - **groupId はいかなる層のキーにも参加しない**（§5-2。入力型に groupId を持たせない）。
 *   - 類似候補（層2）は**提示のみ**。自動登録・自動除外は絶対にしない。
 *   - この関数は判定するだけで何も書き込まない（解決はリンク方式・呼び出し側の管轄）。
 */
import type { JournalEntry, Side } from './types';
import { parseRowKey } from './importIdentity';

export type ImportDecisionStatus = 'registered' | 'linked' | 'ignored';

/** ImportDecision（§1-2・データ層の新ストア）のうちデデュープ判定に要る部分。 */
export interface ImportDecisionSummary {
  status: ImportDecisionStatus;
  /** registered / linked のとき必須・ignored のとき無し（schema はデータ層で強制）。 */
  entryId?: string;
  /**
   * 決定の由来ファイルの SHA-256（provenance.fileHash）。fingerprint 型キーの
   * 「同一ファイルの再取込」判定に使う。欠けている場合は同一性を確認できないため、
   * fp キーのヒットはレビューへ出す（fail-closed）。
   */
  fileHash?: string;
}

export type ImportRowResolutionStatus =
  | 'decided'
  | 'unresolved'
  | 'unresolved-prior-decision'
  | 'unresolved-dangling';

/** 判定に必要な行の最小形（NormalizedRow の部分集合。groupId は受け取らない）。 */
export interface DedupRow {
  rowKey: string;
  /** ISO 日付。類似候補の日付窓に使う。 */
  date: string;
  amount: number;
  ownSide: Side;
}

export interface ImportRowResolution {
  rowKey: string;
  status: ImportRowResolutionStatus;
  /** ヒットした決定（decided / prior-decision / dangling のとき）。 */
  decision?: ImportDecisionSummary;
  /** 類似候補の仕訳 ID（提示のみ・自動処理禁止）。日付の近い順。 */
  similarEntryIds: string[];
}

export interface ResolveImportRowsInput {
  /** ファイル内順の行（同順で結果を返す）。 */
  rows: readonly DedupRow[];
  /** 既存の決定（rowKey → 要約）。取込済み判定の正本 = ImportDecision ストア（§1-2）。 */
  decisions: ReadonlyMap<string, ImportDecisionSummary>;
  /** 既存仕訳（dangling 判定と類似候補に使う）。 */
  existingEntries: readonly JournalEntry[];
  /**
   * レビュー中ファイルの SHA-256。fingerprint 型キーの「同一ファイルの再取込」判定に使う。
   * 未指定なら同一性を確認できないため、fp キーの決定済みヒットは黙ってスキップせず
   * レビューへ出す（fail-closed）。
   */
  fileHash?: string;
  /**
   * 自口座の勘定科目 ID（binding 由来）。未指定なら類似候補は出さない
   * （「自口座一致」を満たせないため。判定そのものには影響しない）。
   */
  ownAccountId?: string;
  /** 類似候補の日付窓（±N 日）。既定 3。 */
  similarWindowDays?: number;
}

/** 類似候補の提示上限（レビュー UI が溢れないように）。 */
export const SIMILAR_CANDIDATE_LIMIT = 5;

/** ISO 日付を通算日数へ（TZ 非依存・決定的）。不正な形式は undefined。 */
function dayNumber(isoDate: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/**
 * 行ごとの重複判定（層1: rowKey 決定的照合 + fp キーの同一ファイル規則）と
 * 類似候補（層2: 日付±N日・同額・自口座一致）を返す。入力と同順。
 */
export function resolveImportRows(input: ResolveImportRowsInput): ImportRowResolution[] {
  const windowDays = input.similarWindowDays ?? 3;
  const entryIds = new Set(input.existingEntries.map((e) => e.id));

  // 類似候補の索引: 自口座の行の (側, 金額) → 仕訳（existingEntries の順を保つ）。
  // 未決行があるときだけ 1 回構築し、行ごとの全仕訳走査（未決 M 行 × 全 N 仕訳）を
  // M × バケット分に減らす。判定条件・順序は従来の全走査と完全に同一。
  let similarIndex: Map<string, { id: string; date: string }[]> | undefined;
  const buildSimilarIndex = (): Map<string, { id: string; date: string }[]> => {
    const index = new Map<string, { id: string; date: string }[]>();
    for (const entry of input.existingEntries) {
      for (const line of entry.lines) {
        if (line.accountId !== input.ownAccountId) continue;
        const key = `${line.side}|${line.amount}`;
        const bucket = index.get(key);
        if (bucket === undefined) {
          index.set(key, [{ id: entry.id, date: entry.date }]);
        } else if (bucket[bucket.length - 1]!.id !== entry.id) {
          // 同一仕訳内に同型の行が複数あっても候補は 1 回（従来の some() と同じ）。
          bucket.push({ id: entry.id, date: entry.date });
        }
      }
    }
    return index;
  };

  // 類似候補: 自口座 accountId が分かるときだけ、自口座の行（同じ側・同額）を持つ
  // 既存仕訳を日付±N日で拾う。提示のみ（§5-2 層2）。
  const findSimilar = (row: DedupRow): string[] => {
    if (input.ownAccountId === undefined) return [];
    const day = dayNumber(row.date);
    if (day === undefined) return [];
    similarIndex ??= buildSimilarIndex();
    const bucket = similarIndex.get(`${row.ownSide}|${row.amount}`);
    if (bucket === undefined) return [];
    const hits: { id: string; distance: number; date: string }[] = [];
    for (const candidate of bucket) {
      const entryDay = dayNumber(candidate.date);
      if (entryDay === undefined) continue;
      const distance = Math.abs(entryDay - day);
      if (distance > windowDays) continue;
      hits.push({ id: candidate.id, distance, date: candidate.date });
    }
    hits.sort((a, b) => a.distance - b.distance || a.date.localeCompare(b.date));
    return hits.slice(0, SIMILAR_CANDIDATE_LIMIT).map((h) => h.id);
  };

  return input.rows.map((row): ImportRowResolution => {
    const decision = input.decisions.get(row.rowKey);

    if (decision !== undefined) {
      // registered / linked で参照先仕訳が実在しなければ dangling（§1-2 の防御・最優先）。
      if (decision.status !== 'ignored') {
        if (decision.entryId === undefined || !entryIds.has(decision.entryId)) {
          return {
            rowKey: row.rowKey,
            status: 'unresolved-dangling',
            decision,
            similarEntryIds: findSimilar(row),
          };
        }
      }
      // fingerprint 型キー: 同一ファイルの再取込だけ黙ってスキップ（作者決定・P1-1）。
      // 別ファイル（または fileHash 不明）では「以前の取込と同一の可能性」としてレビューへ。
      const parsed = parseRowKey(row.rowKey);
      if (parsed?.body.type === 'fp') {
        const sameFile =
          decision.fileHash !== undefined &&
          input.fileHash !== undefined &&
          decision.fileHash === input.fileHash;
        if (!sameFile) {
          return {
            rowKey: row.rowKey,
            status: 'unresolved-prior-decision',
            decision,
            similarEntryIds: [],
          };
        }
      }
      return { rowKey: row.rowKey, status: 'decided', decision, similarEntryIds: [] };
    }

    return { rowKey: row.rowKey, status: 'unresolved', similarEntryIds: findSimilar(row) };
  });
}

/* ── 取込開始日 cutoff（処理順④・§B） ── */

export interface ImportFromDateCutoffResult<R> {
  /** cutoff 後もレビュー対象に残る行（入力順を保つ）。 */
  rows: R[];
  /** rows と同順の判定。 */
  resolutions: ImportRowResolution[];
  /** cutoff で明示 skip になった行（件数会計へ合流させる）。行順。 */
  skipped: { rowIndex: number; reasonCode: 'before-import-start' }[];
}

/**
 * 取込開始日（binding.importFromDate）の cutoff を decision 照合の**後**に適用する（処理順④）。
 *
 *  - skip するのは**未決定（status='unresolved'）かつ date < importFromDate** の行だけ。
 *    決定済み（decided）は従来どおり決定的スキップが優先され、決定を持つ行
 *    （prior-decision / dangling）は cutoff で隠さずレビューへ出す（fail-closed:
 *    壊れた決定・要確認の行が開始日の陰に消えない）。
 *  - **決定（ImportDecision）は作らない** — 開始日を過去へ動かせば当該行は普通の未解決として
 *    レビューへ戻る（可逆）。
 *  - occurrence 採番（②）と decision 照合（③）は全母集合で済んでいるため、この関数は
 *    行の同一性に影響しない。
 */
export function applyImportFromDateCutoff<R extends { date: string; rowIndex: number }>(
  rows: readonly R[],
  resolutions: readonly ImportRowResolution[],
  importFromDate: string | undefined,
): ImportFromDateCutoffResult<R> {
  if (importFromDate === undefined) {
    return { rows: [...rows], resolutions: [...resolutions], skipped: [] };
  }
  const kept: R[] = [];
  const keptResolutions: ImportRowResolution[] = [];
  const skipped: ImportFromDateCutoffResult<R>['skipped'] = [];
  rows.forEach((row, index) => {
    const resolution = resolutions[index]!;
    if (resolution.status === 'unresolved' && row.date < importFromDate) {
      skipped.push({ rowIndex: row.rowIndex, reasonCode: 'before-import-start' });
      return;
    }
    kept.push(row);
    keptResolutions.push(resolution);
  });
  return { rows: kept, resolutions: keptResolutions, skipped };
}
