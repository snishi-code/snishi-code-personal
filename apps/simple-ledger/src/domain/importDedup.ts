/*
 * デデュープ層（指示書 §5-2）。**分離可能な独立パーツ**として設計する:
 * 後で照合アルゴリズムを差し替えられるよう、ストレージ・UI・profile に依存しない
 * 純関数だけを置く。呼び出し側（data / UI フェーズ）との契約は次のとおり。
 *
 *  入力: rowKey 付きの正規化行の列（ファイル内順。rowKey はファイル内で一意 —
 *        ext キーのファイル内衝突は評価段階で error 行に倒してあり、fp キーは
 *        occurrence 採番で衝突しない）・既存 ImportDecision の Map（rowKey → 要約。
 *        ファイル外の rowKey を含む**全決定**を渡してよい。参照するのは行と同一キーのみ）・
 *        既存仕訳の列（dangling 判定と類似候補の提示用）。
 *  出力: 入力と同順の行別判定。
 *   - 'decided'             = 決定済み（黙って除外してよい行・件数だけ表示）
 *   - 'unresolved'          = 未決定（レビューへ）。同一 fingerprint の決定済み occurrence より
 *                             後の行（部分適用の残り・新しく増えた行）も**普通の未解決**として
 *                             ここに入る（不一致扱いにしない）。
 *   - 'unresolved-dangling' = 決定はあるが参照先仕訳が実在しない（§1-2）。レビューへ出すが、
 *                             決定の削除は**ユーザーの明示操作**（UI → store 経由）だけが行う。
 *
 *  規則:
 *   - この層は**読み取り専用**の判定器。decision の削除・変更をどの経路でも指示しない。
 *   - 同一 fingerprint の出現数が過去の決定より少ないファイル（n < k）は行の判定を変えず、
 *     findOccurrenceShortages が**情報提示用の警告**として別途返す（件数会計の近くに表示）。
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
}

export type ImportRowResolutionStatus = 'decided' | 'unresolved' | 'unresolved-dangling';

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
  /** ヒットした決定（decided / dangling のとき）。 */
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
 * 行ごとの重複判定（層1: rowKey 決定的照合）と
 * 類似候補（層2: 日付±N日・同額・自口座一致）を返す。入力と同順。
 */
export function resolveImportRows(input: ResolveImportRowsInput): ImportRowResolution[] {
  const windowDays = input.similarWindowDays ?? 3;
  const entryIds = new Set(input.existingEntries.map((e) => e.id));

  // 類似候補: 自口座 accountId が分かるときだけ、自口座の行（同じ側・同額）を持つ
  // 既存仕訳を日付±N日で拾う。提示のみ（§5-2 層2）。
  const findSimilar = (row: DedupRow): string[] => {
    if (input.ownAccountId === undefined) return [];
    const day = dayNumber(row.date);
    if (day === undefined) return [];
    const hits: { id: string; distance: number; date: string }[] = [];
    for (const entry of input.existingEntries) {
      const entryDay = dayNumber(entry.date);
      if (entryDay === undefined) continue;
      const distance = Math.abs(entryDay - day);
      if (distance > windowDays) continue;
      const matches = entry.lines.some(
        (l) =>
          l.accountId === input.ownAccountId && l.side === row.ownSide && l.amount === row.amount,
      );
      if (matches) hits.push({ id: entry.id, distance, date: entry.date });
    }
    hits.sort((a, b) => a.distance - b.distance || a.date.localeCompare(b.date));
    return hits.slice(0, SIMILAR_CANDIDATE_LIMIT).map((h) => h.id);
  };

  return input.rows.map((row): ImportRowResolution => {
    const decision = input.decisions.get(row.rowKey);

    if (decision !== undefined) {
      if (decision.status === 'ignored') {
        return { rowKey: row.rowKey, status: 'decided', decision, similarEntryIds: [] };
      }
      // registered / linked: 参照先仕訳が実在しなければ dangling（§1-2 の防御）。
      if (decision.entryId !== undefined && entryIds.has(decision.entryId)) {
        return { rowKey: row.rowKey, status: 'decided', decision, similarEntryIds: [] };
      }
      return {
        rowKey: row.rowKey,
        status: 'unresolved-dangling',
        decision,
        similarEntryIds: findSimilar(row),
      };
    }

    return { rowKey: row.rowKey, status: 'unresolved', similarEntryIds: findSimilar(row) };
  });
}

/* ── 出現数の情報提示（n < k の警告・行の判定には影響しない） ── */

/** 同一 fingerprint の出現数が過去の決定より少ないファイルの警告材料。 */
export interface FingerprintOccurrenceShortage {
  /** 対象の fingerprint（16 進）。表示は先頭数桁で足りる。 */
  fingerprint: string;
  /** 過去の決定から分かる出現数の下限（決定済み occurrence の最大値 = k）。 */
  knownCount: number;
  /** 今回のファイル内の出現数（= n）。 */
  fileCount: number;
}

/**
 * ファイル内の同一 fingerprint 出現数 n が、決定済み occurrence の最大値 k を下回る
 * グループを返す（n < k = 過去の取込より行が少ないファイル）。**情報提示のみ**:
 * 決定の削除も強制レビューもしない。decisionKeys にはファイル外の rowKey を含む
 * **全決定のキー**を渡すこと（ファイル内のキーだけでは occurrence k を見落とす）。
 * 名前空間（sourceId・identityVersion）が違う決定は突き合わせない。
 */
export function findOccurrenceShortages(
  rows: readonly Pick<DedupRow, 'rowKey'>[],
  decisionKeys: Iterable<string>,
): FingerprintOccurrenceShortage[] {
  // ファイル内の出現数（(sourceId, version, fingerprint) グループ別・出現順を保つ）。
  const fileCounts = new Map<string, { fingerprint: string; count: number }>();
  for (const row of rows) {
    const parsed = parseRowKey(row.rowKey);
    if (parsed === undefined || parsed.body.type !== 'fp') continue;
    const g = encodeGroup([parsed.sourceId, parsed.identityVersion, parsed.body.fingerprint]);
    const current = fileCounts.get(g);
    if (current !== undefined) current.count += 1;
    else fileCounts.set(g, { fingerprint: parsed.body.fingerprint, count: 1 });
  }
  if (fileCounts.size === 0) return [];

  // 既知の出現数 = 同一グループの決定済み occurrence の最大値。
  const knownCounts = new Map<string, number>();
  for (const key of decisionKeys) {
    const parsed = parseRowKey(key);
    if (parsed === undefined || parsed.body.type !== 'fp') continue;
    const g = encodeGroup([parsed.sourceId, parsed.identityVersion, parsed.body.fingerprint]);
    if (!fileCounts.has(g)) continue;
    const prev = knownCounts.get(g) ?? 0;
    if (parsed.body.occurrence > prev) knownCounts.set(g, parsed.body.occurrence);
  }

  const shortages: FingerprintOccurrenceShortage[] = [];
  for (const [g, info] of fileCounts) {
    const known = knownCounts.get(g) ?? 0;
    if (known > info.count) {
      shortages.push({ fingerprint: info.fingerprint, knownCount: known, fileCount: info.count });
    }
  }
  return shortages;
}

/** グループキーの内部エンコード（JSON 配列 = canonical・衝突なし）。 */
function encodeGroup(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}
