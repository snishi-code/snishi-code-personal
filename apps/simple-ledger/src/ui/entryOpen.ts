/*
 * 仕訳カードをタップしたとき何を開くかの単一正本。
 *
 * アプリ全体の原則（作者決定 2026-08-14）: 仕訳カードはタップで**編集**できるか、
 * その仕訳を**生み出した宣言**（定期ルール・継続コスト項目・投資科目）へ辿れる。
 * くり返し記帳が起票した実仕訳は後者（作者決定 2026-08-15）。ルールは定期起票するだけの
 * 軽い道具で、生まれたものへの個別操作は持たない＝未起票の投影と同じ行き先になる。
 * 画面ごとにこの分岐を手書きすると「ホームだけ仕訳一覧へ飛ぶ」「資金繰りだけ
 * タップできない」といった食い違いが生まれる（実際に両方起きた）。判定はここへ集約し、
 * 消費側（仕訳一覧・ホーム・資金繰り）は返った計画を実行するだけにする。
 */
import type { JournalEntry } from '../domain/types';
import { derivedEntryOrigin } from '../domain/derivedOrigin';
import { generatedEntryRuleId } from '../domain/recurringIds';

export type EntryOpenPlan =
  /** 通常の保存仕訳 → 仕訳の編集シート。 */
  | { kind: 'edit' }
  /** 初期残高 → 専用シート（通常の編集シートでは不変条件を守れない）。 */
  | { kind: 'opening' }
  /** 残高補正 → 専用シート。 */
  | { kind: 'adjustment' }
  /** 定期ルールの投影・**および起票済みの実仕訳** → そのルール（毎月のもの）。 */
  | { kind: 'rule'; ruleId: string }
  /** 継続コストの月割り・購入投影 → その項目（毎月のもの）。 */
  | { kind: 'item'; itemId: string }
  /** 投資の利回り投影 → 利回りを宣言した科目（勘定科目）。 */
  | { kind: 'account'; accountId: string }
  /** 由来を名乗らない導出行 → 開く先が無い（既定の遷移先へ流さない＝誤遷移させない）。 */
  | { kind: 'none' };

export function entryOpenPlan(entry: JournalEntry): EntryOpenPlan {
  if (entry.metadata?.virtual === true) {
    const origin = derivedEntryOrigin(entry);
    if (origin === undefined) return { kind: 'none' };
    if (origin.kind === 'recurringRule') return { kind: 'rule', ruleId: origin.recurringRuleId };
    if (origin.kind === 'monthlyCost') return { kind: 'item', itemId: origin.monthlyCostId };
    return { kind: 'account', accountId: origin.accountId };
  }
  if (entry.metadata?.adjustment !== undefined) return { kind: 'adjustment' };
  // くり返し記帳から生まれた**保存済み**仕訳は、未起票の投影とまったく同じ扱い
  // （作者決定 2026-08-15: 生まれたものへの個別操作は不可・調整はルール側で）。
  // 導出行と実仕訳で行き先が変わらない＝利用者から見て 1 種類の行になる。
  const generatedRuleId = generatedEntryRuleId(entry);
  if (generatedRuleId !== undefined) return { kind: 'rule', ruleId: generatedRuleId };
  if (entry.kind === 'opening') return { kind: 'opening' };
  return { kind: 'edit' };
}
