/*
 * ルールの切り替え・終了と、配分中 item の清算。
 * v13.15 §2.1: Allocations.tsx からの機械的な切り出し（挙動不変）。
 */
/*
 * 月割り台帳。
 *  - くり返し記帳（定期ルール）: 実仕訳の自動起票（正本は起票された仕訳）。
 *    貸方・借方を簿記編集で直接指定し、行き先が費用なら自動で継続コスト台帳を経由する。
 *  - 継続コスト資産: 項目名・金額・開始日・終了日の4項目。終了日までの月割りは導出で、
 *    終了日を過ぎたら一覧から消える（アーカイブ = 終了日の設定）。
 *  - ローン（v13.6 H4）: 専用セクションは持たない。**計上先が負債科目のルール**が
 *    そのままローンで、持ち物・定期と同じ一覧に混在して並ぶ（検索・並び替えが一体で効く）。
 *    ルールを持たない負債（クレカ等）はここに出ない＝区別はルールの有無だけ。
 *    資金繰りの負債行タップ（target.liabilityAccountId）は該当ルール行へ着地する。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../overlays';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { AccountPicker } from '../AccountPicker';
import { useLedger } from '../../state/store';
import { remainingValue } from '../../domain/monthlyCost';
import {
  recoveredAmountsByItem,
  spreadTotalOf as computeSpreadTotal,
} from '../../domain/continuousCost';
import { parseRuleItemId, parseRuleLoanItemId } from '../../domain/recurringIds';
import { loanRemainingDebt, loanSettledAmountsByItem, loanSpreadTotalOf } from '../../domain/loan';
import type {} from '../../domain/accountRoles';
import { groupedAccountsByRole, groupedRecoveryDestinationAccounts } from '../accountOptions';
import { isLedgerDate, MAX_LEDGER_DATE, MIN_LEDGER_DATE } from '../../domain/calendar';
import { todayLocal } from '../../util/time';
import {
  CATCH_UP_HARD_CAP_MONTHS,
  RECURRING_POSTABLE_ROLES,
  deriveRecurringOutputs,
  firstRecurringPostingDate,
  minRecurringRuleCloseDate,
} from '../../domain/recurring';
import {
  earliestRecurringRuleEndDate,
  effectiveRecurringRuleStartDate,
} from '../../domain/accountLifetime';
import {
  exactDigitsFor,
  formatMinorForInput,
  parseAmountToMinor,
  sanitizeAmountText,
} from '../amountText';
import { useMoneyDigits } from '../money';
import { moneyText } from '../money';
import { errorText, t } from '../../i18n';
import type {} from '../../i18n';
import type { FractionDigits } from '../../util/format';
import { UI } from '../../ui-contract';
import type { RecurringRuleSettlementInput } from '../../data/repository';
import type { MonthlyCostItem, RecurringRule } from '../../domain/types';

/* ── ルールの切り替え・終了と、配分中 item の清算（v13） ── */

/**
 * splitFromRuleId で連結する系譜（connected component）のルール。
 * 保存境界（repository.lineageRuleIds）と同じ規則の読み取り版で、清算できる item の
 * 母集合を「同じ位置から伸びた線分たち」に限る（系譜外は保存側が fail-closed に弾く）。
 */
function lineageRules(rules: readonly RecurringRule[], ruleId: string): RecurringRule[] {
  const ids = new Set<string>([ruleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        if (rule.splitFromRuleId !== undefined && !ids.has(rule.splitFromRuleId)) {
          ids.add(rule.splitFromRuleId);
          grew = true;
        }
      } else if (rule.splitFromRuleId !== undefined && ids.has(rule.splitFromRuleId)) {
        ids.add(rule.id);
        grew = true;
      }
    }
  }
  return rules.filter((rule) => ids.has(rule.id));
}

/**
 * 清算できる 1 件 = **起票月**（v13.15 §2.4 で月単位へ再編）。清算の保存形は
 * RuleSettlement { month, endDate } で、その月の持ち物 item（ccr-）とローン item（ccl-・
 * loan ブロック付きルールのみ）の**両方に一様に効く**ため、keep/end の決定は月に 1 つ。
 * 控除実仕訳の形だけが item の性質から変わる: 持ち物 → 回収の振替／ローン → 一括返済。
 */
interface SettlementCandidate {
  /** その月を導出した線分（系譜内のどれか）と起票月。 */
  ruleId: string;
  month: string;
  /** 持ち物 item（ccr-）。残存価値 > 0 のときだけ載る（回収欄の表示条件）。 */
  item?: MonthlyCostItem;
  remaining: number;
  digits: FractionDigits;
  defaultRecoveryText: string;
  /** ローン item（ccl-）。残債 > 0 のときだけ載る（一括返済欄の表示条件）。 */
  loanItem?: MonthlyCostItem;
  loanRemaining: number;
  loanDigits: FractionDigits;
  defaultLoanRepaymentText: string;
  /** 表示（名前・期間）の代表 item。 */
  display: MonthlyCostItem;
}

/** 1 月ぶんの選択（回収の意味論はアーカイブシートと同一・一括返済は §2.4）。 */
interface SettlementDraft {
  mode: 'keep' | 'end';
  recoveryText: string;
  recoveryAccountId: string;
  remainderMode: 'spread' | 'expense';
  /** ローンの一括返済（既定額 = 理論残債・既定返済元 = loan ブロック）。 */
  loanRepaymentText: string;
  loanSourceAccountId: string;
}

interface RecurringSettlementState {
  candidates: SettlementCandidate[];
  draftOf: (candidate: SettlementCandidate) => SettlementDraft;
  update: (candidate: SettlementCandidate, patch: Partial<SettlementDraft>) => void;
  /** switchRecurringRule へ渡す清算（「この日で終える」を選んだぶんだけ）。 */
  inputs: RecurringRuleSettlementInput[];
  /** 回収額 > 0 なのに回収先が未選択の行が無いか（保存ボタンの活性）。 */
  canSave: boolean;
}

function defaultSettlementDraft(candidate: SettlementCandidate): SettlementDraft {
  return {
    mode: 'keep',
    recoveryText: candidate.defaultRecoveryText,
    recoveryAccountId: '',
    remainderMode: 'spread',
    loanRepaymentText: candidate.defaultLoanRepaymentText,
    loanSourceAccountId: candidate.loanItem?.repaymentSourceAccountId ?? '',
  };
}

/** 月候補のキー（drafts の索引）。 */
function candidateKey(candidate: Pick<SettlementCandidate, 'ruleId' | 'month'>): string {
  return `${candidate.ruleId}\u0000${candidate.month}`;
}

/**
 * 切り替えシート・終了シートが共有する清算 state（対象の導出と 0〜2 本の回収の組み立て）。
 *
 * 対象 = **この系譜が導出した配分中の item**（切り替え日の時点でまだ残存価値があり、
 * その日が期間の内側にあるもの）。「生まれた線は自分の寿命を持つ」ので、何も選ばなければ
 * それぞれの終了日まで走り切る（= settlements を 1 件も送らない）。
 */
function useRecurringSettlements(
  rule: RecurringRule,
  effectiveDate: string,
): RecurringSettlementState {
  const { ledger } = useLedger();
  const displayDigits = useMoneyDigits();
  // 上限（2100 年）超えの切り替え日で導出を走らせない（E の無制限展開をこの経路へ
  // 持ち込まない。上限内なら展開は高々 2100 年まで = 有界）。
  const dateValid = isLedgerDate(effectiveDate);
  const recovered = useMemo(() => recoveredAmountsByItem(ledger?.journalEntries ?? []), [ledger]);
  const loanSettled = useMemo(
    () => loanSettledAmountsByItem(ledger?.journalEntries ?? []),
    [ledger],
  );

  const candidates = useMemo<SettlementCandidate[]>(() => {
    // 台帳を経由しないルールは item を生まない = 清算する対象がそもそも無い。
    if (rule.spreadExpenseAccountId === undefined || !dateValid) return [];
    // 地平は today ではなく**切り替え日**（宣言された日付）。today で切ると、未来の
    // 切り替え日に対して today〜切り替え日の間に起票される item が候補から漏れ、
    // 古い終了日のまま走り続ける（v13.4 の today 規約 = 導出は宣言日だけで決まる。監査 B）。
    const { items } = deriveRecurringOutputs(
      lineageRules(ledger?.recurringRules ?? [], rule.id),
      ledger?.accounts ?? [],
      effectiveDate,
    );
    // 月単位のグループ（v13.15 §2.4）: 同じ起票月の 持ち物（ccr-）とローン（ccl-）は
    // 1 つの清算（endDate = 切り替え日）で一様に締まるため、候補も 1 行にまとめる。
    const byMonth = new Map<string, SettlementCandidate>();
    for (const item of items) {
      const inFlight =
        item.startDate < effectiveDate &&
        (item.endDate === undefined || item.endDate > effectiveDate);
      if (!inFlight) continue;
      const ccrOrigin = parseRuleItemId(item.id);
      const cclOrigin = parseRuleLoanItemId(item.id);
      const origin = ccrOrigin ?? cclOrigin;
      if (origin === undefined) continue;
      const key = candidateKey(origin);
      const group =
        byMonth.get(key) ??
        ({
          ruleId: origin.ruleId,
          month: origin.month,
          remaining: 0,
          digits: displayDigits,
          defaultRecoveryText: '',
          loanRemaining: 0,
          loanDigits: displayDigits,
          defaultLoanRepaymentText: '',
          display: item,
        } as SettlementCandidate);
      if (ccrOrigin !== undefined) {
        const remaining = remainingValue(item, effectiveDate, computeSpreadTotal(item, recovered));
        // 残存価値が尽きている item は「終える」ことに意味が無い（作る仕訳も無い）。
        if (remaining > 0) {
          // 表示桁 0 の設定でも、この欄だけは端数を隠さない（見えている値 = 保存される値）。
          const digits = Math.max(displayDigits, exactDigitsFor(remaining)) as FractionDigits;
          group.item = item;
          group.remaining = remaining;
          group.digits = digits;
          group.defaultRecoveryText = formatMinorForInput(remaining, digits);
          group.display = item;
        }
      } else {
        // ローン側: 既定の一括返済額 = 切り替え日の理論残債（loan.ts の単一正本）。
        const spread = loanSpreadTotalOf(item, loanSettled);
        const loanRemaining = loanRemainingDebt(item, effectiveDate, spread);
        if (loanRemaining > 0) {
          const digits = Math.max(displayDigits, exactDigitsFor(loanRemaining)) as FractionDigits;
          group.loanItem = item;
          group.loanRemaining = loanRemaining;
          group.loanDigits = digits;
          group.defaultLoanRepaymentText = formatMinorForInput(loanRemaining, digits);
          if (group.item === undefined) group.display = item;
        }
      }
      if (group.item !== undefined || group.loanItem !== undefined) byMonth.set(key, group);
    }
    return [...byMonth.values()].sort((a, b) =>
      a.display.startDate < b.display.startDate ? -1 : 1,
    );
  }, [ledger, rule, effectiveDate, dateValid, recovered, loanSettled, displayDigits]);

  const [drafts, setDrafts] = useState<Record<string, SettlementDraft>>({});
  // 回収額・一括返済額の既定は切り替え日に追従する。既定のままなら追従し、手で直してあれば
  // その値を尊重する（判定はフラグではなく値 = アーカイブシートと同じ流儀）。
  const autoRecoveryRef = useRef<Record<string, string>>({});
  const autoLoanRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const pending = candidates.filter((candidate) => {
      const key = candidateKey(candidate);
      return (
        autoRecoveryRef.current[key] !== candidate.defaultRecoveryText ||
        autoLoanRef.current[key] !== candidate.defaultLoanRepaymentText
      );
    });
    if (pending.length === 0) return;
    const previousAuto: Record<string, string | undefined> = {};
    const previousLoanAuto: Record<string, string | undefined> = {};
    for (const candidate of pending) {
      const key = candidateKey(candidate);
      previousAuto[key] = autoRecoveryRef.current[key];
      previousLoanAuto[key] = autoLoanRef.current[key];
      autoRecoveryRef.current[key] = candidate.defaultRecoveryText;
      autoLoanRef.current[key] = candidate.defaultLoanRepaymentText;
    }
    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const candidate of pending) {
        const key = candidateKey(candidate);
        const draft = next[key];
        if (draft === undefined) continue; // まだ触られていない行は draftOf の既定が追従する。
        let patched = draft;
        if (draft.recoveryText === previousAuto[key]) {
          patched = { ...patched, recoveryText: candidate.defaultRecoveryText };
        }
        if (draft.loanRepaymentText === previousLoanAuto[key]) {
          patched = { ...patched, loanRepaymentText: candidate.defaultLoanRepaymentText };
        }
        if (patched !== draft) {
          next[key] = patched;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [candidates]);

  const draftOf = (candidate: SettlementCandidate): SettlementDraft =>
    drafts[candidateKey(candidate)] ?? defaultSettlementDraft(candidate);
  const update = (candidate: SettlementCandidate, patch: Partial<SettlementDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [candidateKey(candidate)]: {
        ...(current[candidateKey(candidate)] ?? defaultSettlementDraft(candidate)),
        ...patch,
      },
    }));
  };

  const selected = candidates.filter((candidate) => draftOf(candidate).mode === 'end');
  const inputs: RecurringRuleSettlementInput[] = selected.map((candidate) => {
    const draft = draftOf(candidate);
    const recoveries: { destinationAccountId: string; amount: number }[] = [];
    if (candidate.item !== undefined) {
      const amount = parseAmountToMinor(draft.recoveryText) ?? 0;
      if (amount > 0) {
        recoveries.push({ destinationAccountId: draft.recoveryAccountId, amount });
      }
      // 第 2 の回収の振替（借方 = item の計上先 / 貸方 = 継続コスト台帳）。
      const rest = candidate.remaining - amount;
      if (rest > 0 && draft.remainderMode === 'expense') {
        recoveries.push({ destinationAccountId: candidate.item.expenseAccountId, amount: rest });
      }
    }
    // ローンの一括返済（§2.4）: 額 0 = 実仕訳なし（= D までに全額返済された宣言）も合法。
    const loanAmount =
      candidate.loanItem !== undefined ? (parseAmountToMinor(draft.loanRepaymentText) ?? 0) : 0;
    return {
      ruleId: candidate.ruleId,
      month: candidate.month,
      ...(recoveries.length > 0 ? { recoveries } : {}),
      ...(loanAmount > 0
        ? { loanRepayment: { sourceAccountId: draft.loanSourceAccountId, amount: loanAmount } }
        : {}),
    };
  });
  const canSave = selected.every((candidate) => {
    const draft = draftOf(candidate);
    const recoveryOk =
      candidate.item === undefined ||
      (parseAmountToMinor(draft.recoveryText) ?? 0) === 0 ||
      draft.recoveryAccountId !== '';
    const loanOk =
      candidate.loanItem === undefined ||
      (parseAmountToMinor(draft.loanRepaymentText) ?? 0) === 0 ||
      draft.loanSourceAccountId !== '';
    return recoveryOk && loanOk;
  });

  return { candidates, draftOf, update, inputs, canSave };
}

/**
 * 清算パネル（切り替えシート・終了シートで共通の表示）。
 * 「終える」を選んだ行だけアーカイブシートと同じ 3 点（回収額・回収先・残りの扱い）を出す。
 */
function RecurringSettlementPanel({
  state,
  effectiveDate,
}: {
  state: RecurringSettlementState;
  effectiveDate: string;
}) {
  const { ledger } = useLedger();
  const accounts = ledger?.accounts ?? [];
  const currency = ledger?.settings.currency ?? '';
  if (state.candidates.length === 0) return null;
  return (
    <div className="stack" data-ui={UI.allocations.recurringSettlement}>
      <p className="section-label">{t('recurring.settlementTitle')}</p>
      <p className="field__hint">{t('recurring.settlementIntro')}</p>
      {state.candidates.map((candidate) => {
        const draft = state.draftOf(candidate);
        const recoveryAmount = parseAmountToMinor(draft.recoveryText) ?? 0;
        const loanRepaymentAmount = parseAmountToMinor(draft.loanRepaymentText) ?? 0;
        // 残り = 残存価値 − 回収額。負（超過回収）なら spreadTotal が負になり、過去に
        // わたる費用減として按分される＝「終了日に全額」は選べない。
        const rest = candidate.remaining - recoveryAmount;
        const remainderChoosable = rest > 0;
        const expenseAccountName =
          candidate.item !== undefined
            ? (accounts.find((a) => a.id === candidate.item?.expenseAccountId)?.name ??
              candidate.item.expenseAccountId)
            : '';
        return (
          <div
            className="card card--pad"
            key={candidateKey(candidate)}
            data-ui={UI.allocations.recurringSettlementItem}
            data-item-id={candidate.display.id}
          >
            <div className="list__title">{candidate.display.name}</div>
            <div className="kv">
              <span className="muted">{t('ccItem.period')}</span>
              <span>
                {candidate.display.startDate} 〜 {candidate.display.endDate ?? '—'}
              </span>
            </div>
            {candidate.item !== undefined ? (
              <div className="kv">
                <span className="muted">{t('ccItem.remainingValue')}</span>
                <span>{moneyText(candidate.remaining, currency, candidate.digits)}</span>
              </div>
            ) : null}
            {candidate.loanItem !== undefined ? (
              <div className="kv">
                <span className="muted">{t('loan.remainingDebt')}</span>
                <span>{moneyText(candidate.loanRemaining, currency, candidate.loanDigits)}</span>
              </div>
            ) : null}
            <div className="picker__chips" style={{ marginTop: 'var(--space-2)' }}>
              {(
                [
                  ['keep', 'recurring.settlementKeep', UI.allocations.recurringSettlementKeep],
                  ['end', 'recurring.settlementEnd', UI.allocations.recurringSettlementEnd],
                ] as const
              ).map(([mode, labelKey, dataUi]) => (
                <label className="chip" key={mode}>
                  <input
                    type="radio"
                    className="sr-only"
                    name={`rule-settlement-${candidate.display.id}`}
                    value={mode}
                    checked={draft.mode === mode}
                    onChange={() => state.update(candidate, { mode })}
                    data-ui={dataUi}
                  />
                  <span className="chip__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                  <span className="chip__text">{t(labelKey)}</span>
                </label>
              ))}
            </div>
            {draft.mode === 'end' ? (
              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                {/* ローンの一括返済（§2.4）: 既定額 = 理論残債・既定返済元 = loan ブロック。
                    額 0 = 実仕訳なし（= D までに全額返済された宣言）も合法。 */}
                {candidate.loanItem !== undefined ? (
                  <>
                    <TextInput
                      label={t('loan.settleAmount')}
                      inputMode={candidate.loanDigits === 0 ? 'numeric' : 'decimal'}
                      value={draft.loanRepaymentText}
                      onChange={(v) =>
                        state.update(candidate, {
                          loanRepaymentText: sanitizeAmountText(
                            v,
                            candidate.loanDigits,
                            draft.loanRepaymentText,
                          ),
                        })
                      }
                      hint={t('recurring.settlementLoanHint')}
                      dataUi={UI.allocations.recurringSettlementLoanAmount}
                    />
                    {loanRepaymentAmount > 0 ? (
                      <AccountPicker
                        label={t('loan.settleSource')}
                        required
                        value={draft.loanSourceAccountId}
                        onChange={(id) => state.update(candidate, { loanSourceAccountId: id })}
                        groups={groupedAccountsByRole(
                          accounts,
                          [...RECURRING_POSTABLE_ROLES],
                          draft.loanSourceAccountId,
                          effectiveDate,
                        )}
                        dataUi={UI.allocations.recurringSettlementLoanSource}
                      />
                    ) : null}
                  </>
                ) : null}
                {candidate.item !== undefined ? (
                  <TextInput
                    label={t('ccItem.archiveRecovery')}
                    inputMode={candidate.digits === 0 ? 'numeric' : 'decimal'}
                    value={draft.recoveryText}
                    onChange={(v) =>
                      state.update(candidate, {
                        recoveryText: sanitizeAmountText(v, candidate.digits, draft.recoveryText),
                      })
                    }
                    hint={t('ccItem.archiveRecoveryHint')}
                    dataUi={UI.allocations.recurringSettlementRecoveryAmount}
                  />
                ) : null}
                {/* 回収額 0 = 作る仕訳が無い。回収先は出さない（選ばせて捨てない）。 */}
                {candidate.item !== undefined && recoveryAmount > 0 ? (
                  <AccountPicker
                    label={t('ccItem.archiveRecoveryTo')}
                    required
                    value={draft.recoveryAccountId}
                    onChange={(id) => state.update(candidate, { recoveryAccountId: id })}
                    groups={groupedRecoveryDestinationAccounts(
                      accounts,
                      draft.recoveryAccountId,
                      effectiveDate,
                    )}
                    dataUi={UI.allocations.recurringSettlementRecoveryTo}
                  />
                ) : null}
                {candidate.item !== undefined ? (
                  <fieldset
                    className="field picker"
                    data-ui={UI.allocations.recurringSettlementRemainder}
                  >
                    <legend className="field__label">
                      {t('ccItem.archiveRemainder', {
                        amount: moneyText(rest, currency, candidate.digits),
                      })}
                    </legend>
                    <span className="field__hint">
                      {remainderChoosable
                        ? draft.remainderMode === 'expense'
                          ? t('ccItem.archiveRemainderExpenseHint', { account: expenseAccountName })
                          : t('ccItem.archiveRemainderSpreadHint')
                        : t('ccItem.archiveRemainderNoneHint')}
                    </span>
                    <div className="picker__chips">
                      {(
                        [
                          [
                            'spread',
                            'ccItem.archiveRemainderSpread',
                            UI.allocations.recurringSettlementRemainderSpread,
                          ],
                          [
                            'expense',
                            'ccItem.archiveRemainderExpense',
                            UI.allocations.recurringSettlementRemainderExpense,
                          ],
                        ] as const
                      ).map(([mode, labelKey, dataUi]) => (
                        <label className="chip" key={mode}>
                          <input
                            type="radio"
                            className="sr-only"
                            name={`rule-settlement-remainder-${candidate.display.id}`}
                            value={mode}
                            checked={
                              remainderChoosable ? draft.remainderMode === mode : mode === 'spread'
                            }
                            disabled={!remainderChoosable}
                            onChange={() => state.update(candidate, { remainderMode: mode })}
                            data-ui={dataUi}
                          />
                          <span className="chip__check" aria-hidden="true">
                            <Icon name="check" size={14} />
                          </span>
                          <span className="chip__text">{t(labelKey)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 切り替えシート = 「同じ位置から別の線」を **1 枚で決める**（作者確定 2026-08-16）。
 *
 * 動詞の分離: 「編集 = 全期間（過去も引き直す）」に対して「切り替え = この日から」。
 *  1. **切り替え日**: 既定 = 今日。旧線分はこの日より前まで・この日の起票から後継が担当する
 *     （半開区間 [startDate, endDate)）。
 *  2. **新しい条件**: 金額・起票日・周期。既定は現在のルール値。位相（起票周期の基準月）と
 *     科目・月割りトグルは旧線分から引き継ぐ（保存境界が同じ規則で写す）。
 *  3. **起票プレビュー**: 旧線分の終わりと、新条件での初回起票日を文で出す（重複の防波堤）。
 *  4. **清算パネル**: 台帳経由のルールだけ。配分中 item を「そのまま使い切る / この日で終える」。
 *
 * 状態を変える操作だが、**シートそのものが確認面**なので前置きの確認ダイアログは置かない。
 * 保存は switchRecurringRule 1 回（旧線分の終了・後継の作成・清算・回収の振替が同一 tx）。
 */
export function RecurringRuleSwitchSheet({
  rule,
  onClose,
}: {
  rule: RecurringRule;
  onClose: () => void;
}) {
  const { switchRecurringRule } = useLedger();
  const fractionDigits = useMoneyDigits();
  // 清算済みの月より前で線分を閉じる操作は保存境界（settlementInvalid）が拒否する
  // （v13.9 項目 2 の副作用 = バックストップとして維持）。UI は無効な日付を最初から
  // 選べなくする（v13.12 項目 3）: min = 清算済みの最終起票日の翌日・既定日もクランプ。
  const minEffectiveDate = minRecurringRuleCloseDate(rule) ?? MIN_LEDGER_DATE;
  const [effectiveDate, setEffectiveDate] = useState(() => {
    const today = todayLocal();
    return today < minEffectiveDate ? minEffectiveDate : today;
  });
  const initialAmountText = formatMinorForInput(rule.amount, fractionDigits);
  const [amountText, setAmountText] = useState(initialAmountText);
  // 変更判定はフラグではなく値（初期表示と同じ文字列に戻れば無変更 = 保存済み minor を保持）。
  const amountDirty = amountText !== initialAmountText;
  const [dayText, setDayText] = useState(String(rule.dayOfMonth));
  const [everyText, setEveryText] = useState(String(rule.everyMonths));
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const settlements = useRecurringSettlements(rule, effectiveDate);

  // 起票プレビュー: 新条件で最初に起票される実際の日付（保存はしない・読み取り専用）。
  // 位相は旧線分の startMonth を引き継ぐので、起票日・周期を変えると初回がどこへ動くかが
  // そのまま画面に出る。どれかの入力が不正な間は行ごと出さない（fail-closed）。
  const previewDay = dayText === '' ? Number.NaN : Number.parseInt(dayText, 10);
  const previewEvery = everyText === '' ? Number.NaN : Number.parseInt(everyText, 10);
  // 上限（2100 年）超えは保存境界（schema）でも拒否される。入口で不正扱いにして早く止める。
  const dateValid = isLedgerDate(effectiveDate);
  const previewValid =
    dateValid &&
    Number.isInteger(previewDay) &&
    previewDay >= 1 &&
    previewDay <= 31 &&
    Number.isInteger(previewEvery) &&
    previewEvery >= 1 &&
    previewEvery <= CATCH_UP_HARD_CAP_MONTHS;
  const firstPosting = previewValid
    ? firstRecurringPostingDate({
        startMonth: rule.startMonth,
        dayOfMonth: previewDay,
        everyMonths: previewEvery,
        startDate: effectiveDate,
      })
    : null;
  // 切り替え日までに旧線分が 1 回も起票していないなら、保存境界は切り替えを
  // **編集（全期間の引き直し）**として処理する（v13.9 項目 4）。透過的に扱うが、
  // 「旧線分が残る」プレビューは事実と違うので 1 行だけ言い換える。
  const predecessorZeroPosting =
    dateValid &&
    firstRecurringPostingDate({
      startMonth: rule.startMonth,
      dayOfMonth: rule.dayOfMonth,
      everyMonths: rule.everyMonths,
      startDate: effectiveRecurringRuleStartDate(rule),
      endDate: effectiveDate,
    }) === null;

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    const amount = amountDirty ? (parseAmountToMinor(amountText) ?? 0) : rule.amount;
    if (!Number.isInteger(amount) || amount < 1) {
      setError(t('error.common.amountInvalid'));
      return;
    }
    const dayOfMonth = dayText === '' ? 0 : Number.parseInt(dayText, 10);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      setError(t('error.recurring.dayOfMonthInvalid'));
      return;
    }
    const everyMonths = everyText === '' ? 0 : Number.parseInt(everyText, 10);
    if (
      !Number.isInteger(everyMonths) ||
      everyMonths < 1 ||
      everyMonths > CATCH_UP_HARD_CAP_MONTHS
    ) {
      setError(t('error.recurring.everyMonthsInvalid'));
      return;
    }
    if (!dateValid) {
      setError(t('error.recurring.periodInvalid'));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await switchRecurringRule({
        ruleId: rule.id,
        effectiveDate,
        successor: { amount, dayOfMonth, everyMonths },
        ...(settlements.inputs.length > 0 ? { settlements: settlements.inputs } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('recurring.switchTitle')}
      onClose={onClose}
      dataUi={UI.allocations.recurringSwitchSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={
              submitting ||
              effectiveDate === '' ||
              amountText === '' ||
              dayText === '' ||
              everyText === '' ||
              !settlements.canSave
            }
            data-ui={UI.allocations.recurringSwitchConfirm}
          >
            {t('recurring.switchConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{rule.name}</div>
        <TextInput
          label={t('recurring.switchDate')}
          type="date"
          required
          value={effectiveDate}
          min={minEffectiveDate}
          max={MAX_LEDGER_DATE}
          onChange={setEffectiveDate}
          hint={t('recurring.switchDateHint')}
          dataUi={UI.allocations.recurringSwitchDate}
        />
        <p className="section-label">{t('recurring.switchNewConditions')}</p>
        <TextInput
          label={t('recurring.amount')}
          required
          inputMode={fractionDigits === 0 ? 'numeric' : 'decimal'}
          value={amountText}
          onChange={(v) => setAmountText(sanitizeAmountText(v, fractionDigits, amountText))}
          dataUi={UI.allocations.recurringSwitchAmount}
        />
        <TextInput
          label={t('recurring.switchDayOfMonth')}
          required
          inputMode="numeric"
          value={dayText}
          onChange={(v) => setDayText(v.replace(/[^\d]/g, ''))}
          hint={t('recurring.switchDayOfMonthHint')}
          dataUi={UI.allocations.recurringSwitchDayOfMonth}
        />
        <TextInput
          label={t('recurring.intervalMonths')}
          required
          inputMode="numeric"
          value={everyText}
          onChange={(v) => setEveryText(v.replace(/[^\d]/g, ''))}
          dataUi={UI.allocations.recurringSwitchEvery}
        />
        {dateValid ? (
          <div className="field" data-ui={UI.allocations.recurringSwitchPreview}>
            <span className="field__label">{t('recurring.switchPreview')}</span>
            {predecessorZeroPosting ? (
              <p className="field__hint" data-ui={UI.allocations.recurringSwitchAsEditNote}>
                {t('recurring.switchAsEditNote')}
              </p>
            ) : (
              <p className="field__hint">
                {t('recurring.switchPreviewPredecessor', { date: effectiveDate })}
              </p>
            )}
            {previewValid ? (
              <p className="field__hint">
                {firstPosting !== null
                  ? t('recurring.switchPreviewSuccessor', { date: firstPosting })
                  : t('recurring.switchPreviewSuccessorNone')}
              </p>
            ) : null}
          </div>
        ) : null}
        <RecurringSettlementPanel state={settlements} effectiveDate={effectiveDate} />
      </div>
    </Modal>
  );
}

/**
 * ルールの終了 = 明示的に終了点を打つ（継続コスト item のアーカイブと同じ型の小シート）。
 * 既定 = 「今日で終了する」ときに置ける最小の排他的終了日（earliestRecurringRuleEndDate）。
 * v13: 判定材料は保存仕訳ではなく**今日までの導出行**（保存 rec- は存在しない）。
 * 既定より前の終了点も入力自体は許す — 存在期間の短縮は「生まれたものを消す」ための
 * 正当な操作（作者確定 2026-08-16）で、その場合は当日までの導出も一緒に消える。
 * 終了点は含まない端点なので、一覧の「{date} より前まで」と同じ意味を hint で言い直す。
 *
 * 保存は切り替えと同じ switchRecurringRule（successor = null = 後継を作らない）。清算を
 * 選ばなければ settlements は空 = 終了点だけが入る（従来と同じ結果）。
 */
export function RecurringRuleEndSheet({
  rule,
  onClose,
}: {
  rule: RecurringRule;
  onClose: () => void;
}) {
  const { ledger, switchRecurringRule } = useLedger();
  // 清算済みの月より前で閉じる終了は保存境界（settlementInvalid）が拒否する（バックストップ）。
  // UI は最初から選べなくする（v13.12 項目 3）: min = 清算済みの最終起票日の翌日。
  const minEndDate = minRecurringRuleCloseDate(rule) ?? MIN_LEDGER_DATE;
  const [endDate, setEndDate] = useState(() => {
    const earliest = earliestRecurringRuleEndDate(
      rule,
      deriveRecurringOutputs([rule], ledger?.accounts ?? [], todayLocal()).entries,
      todayLocal(),
    );
    return earliest < minEndDate ? minEndDate : earliest;
  });
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const settlements = useRecurringSettlements(rule, endDate);

  async function submit(): Promise<void> {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await switchRecurringRule({
        ruleId: rule.id,
        effectiveDate: endDate,
        successor: null,
        ...(settlements.inputs.length > 0 ? { settlements: settlements.inputs } : {}),
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={t('recurring.endSheetTitle')}
      onClose={onClose}
      dataUi={UI.allocations.recurringEndSheet}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={submitting || endDate === '' || !settlements.canSave}
            data-ui={UI.allocations.recurringEndSheetConfirm}
          >
            {t('recurring.endSheetConfirm')}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="field__error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </div>
        ) : null}
        <div className="list__title">{rule.name}</div>
        <TextInput
          label={t('recurring.endSheetDate')}
          type="date"
          required
          value={endDate}
          onChange={setEndDate}
          min={minEndDate}
          max={MAX_LEDGER_DATE}
          hint={t('recurring.endSheetBody')}
          dataUi={UI.allocations.recurringEndSheetDate}
        />
        <RecurringSettlementPanel state={settlements} effectiveDate={endDate} />
      </div>
    </Modal>
  );
}
