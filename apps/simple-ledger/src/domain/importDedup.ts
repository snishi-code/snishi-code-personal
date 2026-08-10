/*
 * デデュープ層（指示書 §5-2）。**分離可能な独立パーツ**として設計する:
 * 後で照合アルゴリズムを差し替えられるよう、ストレージ・UI・profile に依存しない
 * 純関数だけを置く。呼び出し側（後続の data フェーズ）との契約は次のとおり。
 *
 *  入力: rowKey 付きの正規化行の列（ファイル内順）・既存 ImportDecision の Map
 *        （rowKey → 決定の要約）・既存仕訳の列（類似候補の提示用）。
 *  出力: 入力と同順の行別判定。
 *   - 'decided'                    = 決定済み（黙って除外してよい行・件数だけ表示）
 *   - 'unresolved'                 = 未決定（レビューへ）
 *   - 'unresolved-count-mismatch'  = 出現数の食い違い（§5-1 の防御。既知 occurrence 数と
 *                                    ファイル内出現数の不一致・ファイル内キー衝突。決定が
 *                                    あってもレビューへ戻す＝黙って skip しない）
 *   - 'unresolved-dangling'        = 決定はあるが参照先仕訳が実在しない（§1-2。レビューへ
 *                                    出し、決定の掃除は呼び出し側が行う）
 *
 *  規則:
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

export type ImportRowResolutionStatus =
  | 'decided'
  | 'unresolved'
  | 'unresolved-count-mismatch'
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
 * 行ごとの重複判定（層1: rowKey 決定的照合 + §5-1 の出現数防御）と
 * 類似候補（層2: 日付±N日・同額・自口座一致）を返す。入力と同順。
 */
export function resolveImportRows(input: ResolveImportRowsInput): ImportRowResolution[] {
  const windowDays = input.similarWindowDays ?? 3;
  const entryIds = new Set(input.existingEntries.map((e) => e.id));

  // 既知の occurrence 数: 決定済みキーを解読し、(sourceIdentity, version, fingerprint) ごとの
  // 最大 occurrence を集める。決定の無い行は痕跡を残さないため、これが「既知の出現数」の正本。
  const knownOccurrences = new Map<string, number>();
  const fpGroupKey = (sourceIdentity: string, version: number, fingerprint: string) =>
    encodeGroup([sourceIdentity, version, fingerprint]);
  for (const key of input.decisions.keys()) {
    const parsed = parseRowKey(key);
    if (parsed === undefined || parsed.body.type !== 'fp') continue;
    const g = fpGroupKey(parsed.sourceIdentity, parsed.identityVersion, parsed.body.fingerprint);
    const prev = knownOccurrences.get(g) ?? 0;
    if (parsed.body.occurrence > prev) knownOccurrences.set(g, parsed.body.occurrence);
  }

  // ファイル内の出現数（fingerprint 別）と、ファイル内 rowKey 衝突（ext キーの重複など）。
  const fileFpCounts = new Map<string, number>();
  const keyCounts = new Map<string, number>();
  for (const row of input.rows) {
    keyCounts.set(row.rowKey, (keyCounts.get(row.rowKey) ?? 0) + 1);
    const parsed = parseRowKey(row.rowKey);
    if (parsed !== undefined && parsed.body.type === 'fp') {
      const g = fpGroupKey(parsed.sourceIdentity, parsed.identityVersion, parsed.body.fingerprint);
      fileFpCounts.set(g, (fileFpCounts.get(g) ?? 0) + 1);
    }
  }

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
    const parsed = parseRowKey(row.rowKey);
    const decision = input.decisions.get(row.rowKey);

    // ファイル内でキーが衝突している（同一 externalId が複数行など）= 決定的照合が
    // 成立しない。全該当行をレビューへ（黙って片方に寄せない）。
    if ((keyCounts.get(row.rowKey) ?? 0) > 1) {
      return {
        rowKey: row.rowKey,
        status: 'unresolved-count-mismatch',
        ...(decision !== undefined ? { decision } : {}),
        similarEntryIds: findSimilar(row),
      };
    }

    // §5-1 の出現数防御: 既知 occurrence 数とファイル内出現数が食い違う fingerprint は
    // その全行をレビューへ（決定があっても黙って skip しない）。
    if (parsed !== undefined && parsed.body.type === 'fp') {
      const g = fpGroupKey(parsed.sourceIdentity, parsed.identityVersion, parsed.body.fingerprint);
      const known = knownOccurrences.get(g);
      const inFile = fileFpCounts.get(g) ?? 0;
      if (known !== undefined && known !== inFile) {
        return {
          rowKey: row.rowKey,
          status: 'unresolved-count-mismatch',
          ...(decision !== undefined ? { decision } : {}),
          similarEntryIds: findSimilar(row),
        };
      }
    }

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

/** グループキーの内部エンコード（JSON 配列 = canonical・衝突なし）。 */
function encodeGroup(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}
