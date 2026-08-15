/*
 * Zod スキーマ。import 時の境界検証はすべてここを通す。
 * 型は src/domain/types.ts と一致させる（z.infer で照合可能）。
 *
 * **`.strict()` を使わない**: 未知キーは zod 既定どおり黙って落とす。撤去済みフィールドの残骸を
 * 持つ既存データ（過去バージョンで保存された IndexedDB レコード・手元の JSON）がそのまま通り、
 * 保存のたびに残骸が落ちて自己修復する。「後方互換をコードで持たない」＝フィールドを消したら
 * コードから消すだけ、を運用面で成立させているのがこの strip 挙動。
 */
import { z } from 'zod';
import {
  APP_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  MAX_LEDGER_REVISION,
  SCHEMA_VERSION,
} from './constants';
import { counterpartRole, isAdjustableAccountType } from './adjustment';
import { isDebitNormal } from './accounting';
import { monthOf, monthsBetween } from './allocation';
import {
  ACCOUNT_ROLES,
  ADJUSTABLE_ACCOUNT_ROLES,
  roleAllowsType,
  type AccountRole,
} from './accountRoles';
import {
  accountIsRetiredAt,
  accountLifetimeViolation,
  accountReferenceIntervals,
  effectiveRecurringRuleStartDate,
  recurringLineageViolations,
  ruleExistsAt,
} from './accountLifetime';
import { accountEndingBalanceViolations } from './accountEnding';
import { isValidIsoDate, isValidIsoMonth } from './calendar';
import { ANNUAL_RETURN_BP_MAX, ANNUAL_RETURN_BP_MIN } from './investmentProjection';
import { CATCH_UP_HARD_CAP_MONTHS, isRecurringPostableRole } from './recurring';
import { parseRuleEntryId, parseRuleItemId, ruleEntryId, ruleItemId } from './recurringIds';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式である必要があります')
  .refine(isValidIsoDate, '暦として正しい日付を指定してください');

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, '月は YYYY-MM 形式である必要があります')
  .refine(isValidIsoMonth, '暦として正しい月を指定してください');

const isoDateTime = z.string().min(1);

export const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);

export const sideSchema = z.enum(['debit', 'credit']);

/**
 * 金額: 正の整数（1/100 単位 = minor。例: 1,234.56 → 123456）。
 * 上限は通貨ガードではなく数値精度ガード（集計が Number の安全整数域を出ないための
 * 1 行あたり上限。10^12 minor = 100 億単位/行）。合算側は domain/safeSum が最終防衛線。
 */
export const MAX_AMOUNT_MINOR = 10 ** 12;
const amountSchema = z
  .number()
  .int('金額は整数で入力してください')
  .positive('金額は 1 以上で入力してください')
  .max(MAX_AMOUNT_MINOR, '金額が大きすぎます')
  .finite();

export const accountRoleSchema = z.enum(
  ACCOUNT_ROLES as unknown as [string, ...string[]],
) as z.ZodType<(typeof ACCOUNT_ROLES)[number]>;

export const accountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    type: accountTypeSchema,
    role: accountRoleSchema,
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    archived: z.boolean(),
    note: z.string().max(500).optional(),
    // 「自由に動かせる」フラグ（daily-asset のみ・false だけ意味を持つ。下の transform で正規化）。
    movable: z.boolean().optional(),
    // 返済設定（負債科目のみ。相互参照の整合はパッケージ superRefine で確認する）。
    repaymentAccountId: z.string().min(1).optional(),
    repaymentDay: z.number().int().min(1).max(31).optional(),
    // 想定利回り（投資科目のみ・年率 bp 整数）と投影の計上先。必ずセットで持つ
    // （superRefine）。計上先は soft reference: 参照先の存在・role はここで検証しない
    // （参照先が消えた後の export を取り込めなくしない。投影エンジンが fail-closed に生成を止める）。
    annualReturnBp: z
      .number()
      .int()
      .min(ANNUAL_RETURN_BP_MIN)
      .max(ANNUAL_RETURN_BP_MAX)
      .finite()
      .optional(),
    projectionAccountId: z.string().min(1).optional(),
    // 箱内の表示順（並び替え機能）。
    sortIndex: z.number().int().min(0).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((a, ctx) => {
    // role は type と整合する必要がある（例: daily-asset は asset のみ）。
    if (!roleAllowsType(a.role, a.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `役割(${a.role})が区分(${a.type})と一致しません。`,
        path: ['role'],
      });
    }
    // 名前は空白のみ不可（通常保存の upsertAccount と同じ不変条件。min(1) は空白を通すため
    // 実効名 = trim 後で判定する。import / 復元が空白名の抜け道にならないようにする）。
    if (a.name.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '勘定科目名が空白のみです。',
        path: ['name'],
      });
    }
    if (a.startDate !== undefined && a.endDate !== undefined && a.startDate > a.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '勘定科目の終了日は開始日以降である必要があります。',
        path: ['endDate'],
      });
    }
    if (a.endDate !== undefined && !a.archived) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '終了日を持つ勘定科目はアーカイブ状態である必要があります。',
        path: ['archived'],
      });
    }
    // 想定利回り + 投影の計上先: investment-asset のみ・必ずセット・自分自身不可（§D）。
    if ((a.annualReturnBp === undefined) !== (a.projectionAccountId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '想定利回りと投影の計上先はセットで設定する必要があります。',
        path: ['annualReturnBp'],
      });
    }
    if (a.annualReturnBp !== undefined && a.role !== 'investment-asset') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '想定利回りは投資科目(investment-asset)にのみ設定できます。',
        path: ['annualReturnBp'],
      });
    }
    if (a.projectionAccountId !== undefined && a.projectionAccountId === a.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '投影の計上先に自分自身は指定できません。',
        path: ['projectionAccountId'],
      });
    }
  })
  .transform((a) => {
    // movable の正規化（保存境界 upsertAccount と同じ規則・fail-soft）:
    //  - true は undefined へ（既定 ON なのでレコードを最小に保つ）。
    //  - daily-asset 以外に付いていたら剥がす（拒否せず自己修復）。
    if (a.movable === undefined) return a;
    if (a.movable === true || a.role !== 'daily-asset') {
      const next = { ...a };
      delete next.movable;
      return next;
    }
    return a;
  });

const tagIdList = z.array(z.string().min(1));

export const journalLineSchema = z.object({
  accountId: z.string().min(1),
  side: sideSchema,
  amount: amountSchema,
});

/*
 * タグ（撤去済み・受理のみ）。
 * 機能は 2026-08-15 に撤去した（実ユーズ 0 件）。schema は v12 の形を保つため残す:
 * import は tags / tagIds を**受理して黙って保持**し、export でそのまま往復させる。
 * フィールドごとの削除は v13 の版上げに同乗させる。
 */
export const tagScopeSchema = z.literal('entry');

export const tagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  scope: tagScopeSchema,
  color: z.string().min(1).max(40).optional(),
  archived: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const inputModeSchema = z.enum(['income', 'expense', 'transfer', 'manual', 'reversal']);

export const adjustmentMetaSchema = z.object({
  accountId: z.string().min(1),
  expectedBalance: z.number().int().finite(),
  actualBalance: z.number().int().finite(),
  delta: z.number().int().finite(),
  counterpartAccountId: z.string().min(1),
});

export const entryMetadataSchema = z.object({
  inputMode: inputModeSchema.optional(),
  reversalOfEntryId: z.string().min(1).optional(),
  adjustment: adjustmentMetaSchema.optional(),
  // 継続コスト資産に紐づく保存仕訳の印。recovery なし = 購入の仕訳 / あり = 回収の振替。
  monthlyCostId: z.string().min(1).optional(),
  monthlyCostRecovery: z.literal(true).optional(),
  // 定期ルールからの自動起票の由来（両方セットで持つ。整合はパッケージ superRefine）。
  recurringRuleId: z.string().min(1).optional(),
  recurringMonth: monthSchema.optional(),
});

export const recurringRuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    amount: amountSchema,
    dayOfMonth: z.number().int().min(1).max(31),
    // 何か月ごとに起票するか（必須。1 = 毎月）。上限は配分月数と同じ（監査 P2-3:
    // これが無いと rule だけ保存できて生成 item が配分上限で保存できない）。
    everyMonths: z.number().int().min(1).max(CATCH_UP_HARD_CAP_MONTHS),
    // 正規化済みの計上先（費用または収入=差引形）。v7 は後方互換を持たず、保存形を
    // spread=計上先 + debit=継続コスト台帳の一つに限定する。
    spreadExpenseAccountId: z.string().min(1).optional(),
    debitAccountId: z.string().min(1),
    creditAccountId: z.string().min(1),
    startMonth: monthSchema,
    // ルールの存在期間（半開区間）。周期 anchor と混同しないよう開始点は必須。
    startDate: isoDate,
    splitFromRuleId: z.string().min(1).optional(),
    endDate: isoDate.optional(),
    postedThroughMonth: monthSchema.optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((rule, ctx) => {
    const effectiveStart = effectiveRecurringRuleStartDate(rule);
    if (rule.endDate !== undefined && effectiveStart >= rule.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '定期ルールの終了日は開始日より後である必要があります',
        path: ['endDate'],
      });
    }
    if (rule.spreadExpenseAccountId === undefined) return;
    // 正規化済みの費用ルールは周期にかかわらず常に継続コスト台帳を経由する（everyMonths >= 1。
    // 毎月の家賃も「起票日開始・当月末終了」の item が毎月生まれて消える）。
    // 借方は継続コスト台帳に固定。
    if (rule.debitAccountId !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `月割りするルールの借方は継続コスト台帳(${CONTINUOUS_COST_LEDGER_ACCOUNT_ID})である必要があります`,
        path: ['debitAccountId'],
      });
    }
  });

/** 配分月数の上限（100 年）。rule の everyMonths・catch-up の走査窓と同じ正本を参照する。 */
const SPREAD_MONTHS_CAP = CATCH_UP_HARD_CAP_MONTHS;

export const monthlyCostItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    amount: amountSchema,
    startDate: isoDate,
    // 終了日は任意。未設定 = 費用の割り振りをしない（残存価値 = 全額）。
    endDate: isoDate.optional(),
    expenseAccountId: z.string().min(1),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((item, ctx) => {
    if (item.endDate === undefined) return;
    // 日で比較・例外なしの単一条件。
    if (item.endDate < item.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '終了日は開始日以降である必要があります',
        path: ['endDate'],
      });
      return;
    }
    // 配分月数は実際の等分数と同じ基準 = 購入月〜終了月で数える。
    if (monthsBetween(monthOf(item.startDate), monthOf(item.endDate)) + 1 > SPREAD_MONTHS_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `配分月数が上限(${SPREAD_MONTHS_CAP}ヶ月)を超えています`,
        path: ['endDate'],
      });
    }
  });

export const journalEntrySchema = z
  .object({
    id: z.string().min(1),
    date: isoDate,
    description: z.string().min(1).max(200),
    lines: z.array(journalLineSchema).min(2),
    memo: z.string().max(1000).optional(),
    kind: z.enum(['normal', 'opening']),
    metadata: entryMetadataSchema.optional(),
    tagIds: tagIdList.optional(),
    // 諸口のグループ ID。v12 は**予約のみ**（UI・集計は未実装）なので形式だけを見る。
    // 相互参照（同 groupId の仕訳が何本あるか等）は検証しない = グループに件数の
    // 不変条件を持たせない設計（1 本に減ったら普通の仕訳に退化する）。
    groupId: z.string().min(1).max(64).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((entry, ctx) => {
    const debits = entry.lines.filter((l) => l.side === 'debit');
    const credits = entry.lines.filter((l) => l.side === 'credit');
    // MVP は「1 借方・1 貸方・同額」のみ。複合仕訳(3 行以上や片側 0/複数)は UI 未対応のため
    // fail-closed で取り込まない（型は将来拡張に備え lines 配列のまま）。
    if (entry.lines.length !== 2 || debits.length !== 1 || credits.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MVP では 1 借方・1 貸方の 2 行仕訳のみ対応しています',
        path: ['lines'],
      });
      return;
    }
    const debit = debits.reduce((s, l) => s + l.amount, 0);
    const credit = credits.reduce((s, l) => s + l.amount, 0);
    if (debit !== credit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `借方(${debit})と貸方(${credit})が一致していません`,
        path: ['lines'],
      });
    }
  });

export const settingsSchema = z.object({
  ledgerName: z
    .string()
    .max(120)
    .refine((value) => value.trim().length > 0),
  currency: z
    .string()
    .max(8)
    .refine((value) => value.trim().length > 0),
  // 表示桁数（0|1|2・入力の刻みも連動）。保存・計算は常に 1/100 固定でこの設定では変わらない。
  // 言語（旧 locale）は台帳でなく端末の属性なので v11 で台帳データから撤去した。
  displayFractionDigits: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

/**
 * エクスポートパッケージ。import の入口検証。
 * appId / schemaVersion は厳格に確認する（未対応版は取り込まない=fail-closed）。
 */
export const ledgerExportPackageSchema = z
  .object({
    appId: z.literal(APP_ID),
    schemaVersion: z.literal(SCHEMA_VERSION),
    ledgerId: z.string().min(1),
    exportedAt: isoDateTime,
    deviceId: z.string().min(1),
    // foundation 封筒の revision（楽観的衝突検出）。v2 では必須（無いファイルは取り込まない）。
    revision: z.number().int().nonnegative().max(MAX_LEDGER_REVISION),
    accounts: z.array(accountSchema),
    journalEntries: z.array(journalEntrySchema),
    tags: z.array(tagSchema),
    monthlyCostItems: z.array(monthlyCostItemSchema),
    recurringRules: z.array(recurringRuleSchema),
    settings: settingsSchema,
  })
  .superRefine((pkg, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // 勘定科目 ID は一意 + type / role マップ。
    // export 日時点で終了済みでない内訳名は箱をまたいでも重複不可（通常保存の upsertAccount
    // と同じ不変条件）。未来の終了点はまだ有効、旧 archived/endなし と過去終了だけ対象外。
    const accountType = new Map<string, string>();
    const accountRole = new Map<string, string>();
    const accountById = new Map<string, (typeof pkg.accounts)[number]>();
    const activeAccountNames = new Set<string>();
    const activeAdjustmentTypes = new Set<string>();
    const exportedDate = pkg.exportedAt.slice(0, 10);
    const nameBasisDate = isValidIsoDate(exportedDate) ? exportedDate : undefined;
    pkg.accounts.forEach((a, i) => {
      if (accountType.has(a.id))
        issue(`勘定科目 ID が重複しています(${a.id})`, ['accounts', i, 'id']);
      accountType.set(a.id, a.type);
      accountRole.set(a.id, a.role);
      accountById.set(a.id, a);
      // 基準日が壊れているときは終了済み判定を推測せず、全科目を有効扱いして重複を拒否する。
      if (nameBasisDate === undefined || !accountIsRetiredAt(a, nameBasisDate)) {
        // 空白違いの同名（例: 「預金」と「預金 」）を別名にしないよう trim 後で比較する。
        const trimmedName = a.name.trim();
        if (activeAccountNames.has(trimmedName))
          issue(`同名の有効な勘定科目が重複しています(${trimmedName})`, ['accounts', i, 'name']);
        activeAccountNames.add(trimmedName);
      }
      // 残高調整科目は「非アーカイブは type ごとに最大 1 件」（指示書v3 §B-4）。
      // 同定が role + type になったため、複数あると補正の相手が非決定になる。
      if (a.role === 'system-adjustment' && !a.archived) {
        if (activeAdjustmentTypes.has(a.type))
          issue(`非アーカイブの残高調整科目(type=${a.type})が複数あります`, [
            'accounts',
            i,
            'role',
          ]);
        activeAdjustmentTypes.add(a.type);
      }
      // 集約モデルの不変条件（聖域化）: 内部集約ロールは唯一の集約口座 id のみ許す。
      // これがないと import で品目別の continuing-cost-asset 科目を再導入できてしまう。
      if (a.role === 'continuing-cost-asset' && a.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID)
        issue(
          `継続コスト台帳(continuing-cost-asset)は集約口座(${CONTINUOUS_COST_LEDGER_ACCOUNT_ID})のみ許可されます`,
          ['accounts', i, 'id'],
        );
      if (
        a.id === CONTINUOUS_COST_LEDGER_ACCOUNT_ID &&
        (a.role !== 'continuing-cost-asset' || a.type !== 'asset')
      )
        issue(
          `集約口座(${CONTINUOUS_COST_LEDGER_ACCOUNT_ID})は資産の継続コスト台帳である必要があります`,
          ['accounts', i, 'role'],
        );
    });
    const hasAccount = (id: string) => accountType.has(id);

    // 返済設定の相互参照（2 パス目: 全科目 map が揃ってから確認する）。
    // 返済口座・返済日は負債（カード・未払 / ローン）にのみ許し、返済口座は存在する日常資産。
    pkg.accounts.forEach((a, i) => {
      const isLiability = a.role === 'payment-liability' || a.role === 'other-liability';
      if (a.repaymentAccountId !== undefined) {
        if (!isLiability)
          issue(
            `勘定科目「${a.name}」の返済口座は負債科目（カード・未払 / ローン）にのみ設定できます`,
            ['accounts', i, 'repaymentAccountId'],
          );
        else if (accountRole.get(a.repaymentAccountId) !== 'daily-asset')
          issue(`勘定科目「${a.name}」の返済口座は存在する日常資産である必要があります`, [
            'accounts',
            i,
            'repaymentAccountId',
          ]);
      }
      if (a.repaymentDay !== undefined && !isLiability)
        issue(
          `勘定科目「${a.name}」の返済日は負債科目（カード・未払 / ローン）にのみ設定できます`,
          ['accounts', i, 'repaymentDay'],
        );
    });

    // 継続コスト ID 集合（仕訳の monthlyCostId 参照検証に使う）。
    const monthlyCostIdSet = new Set(pkg.monthlyCostItems.map((m) => m.id));
    const monthlyCostById = new Map(pkg.monthlyCostItems.map((m) => [m.id, m]));
    const recurringRuleIdSet = new Set(pkg.recurringRules.map((r) => r.id));
    const recurringRuleById = new Map(pkg.recurringRules.map((r) => [r.id, r] as const));
    const recurringPostingMonths = new Map<string, Set<string>>();
    // item ごとの購入の仕訳（monthlyCostId あり・monthlyCostRecovery なし）。不変条件⑥⑦に使う。
    const purchaseEntriesByItem = new Map<string, (typeof pkg.journalEntries)[number][]>();

    // 仕訳 ID は一意 + map。
    const entryById = new Map<string, (typeof pkg.journalEntries)[number]>();
    pkg.journalEntries.forEach((e, ei) => {
      if (entryById.has(e.id))
        issue(`仕訳 ID が重複しています(${e.id})`, ['journalEntries', ei, 'id']);
      entryById.set(e.id, e);
    });

    // 参照整合性: すべての仕訳明細の accountId が accounts に存在すること。
    pkg.journalEntries.forEach((e, ei) => {
      e.lines.forEach((l, li) => {
        if (!hasAccount(l.accountId)) {
          issue(`仕訳「${e.description}」が存在しない勘定科目(${l.accountId})を参照しています`, [
            'journalEntries',
            ei,
            'lines',
            li,
            'accountId',
          ]);
        }
      });

      // 残高補正(adjustment)の参照・相手科目・2行仕訳の一貫性。
      const adj = e.metadata?.adjustment;
      if (adj) {
        const ap = (field: string) => ['journalEntries', ei, 'metadata', 'adjustment', field];
        const targetType = accountType.get(adj.accountId);
        const targetRole = accountRole.get(adj.accountId) as AccountRole | undefined;
        const counter = accountById.get(adj.counterpartAccountId);
        if (targetType === undefined) issue('補正の対象科目が存在しません', ap('accountId'));
        else if (!isAdjustableAccountType(targetType))
          issue('補正の対象科目は資産・負債・費用・収入である必要があります', ap('accountId'));
        // type 検査を通っても role で弾く: 内部集約(継続コスト台帳)と、相手側である
        // 残高調整科目自身（type は expense / revenue なので type では弾けない）。
        else if (targetRole === undefined || !ADJUSTABLE_ACCOUNT_ROLES.includes(targetRole))
          issue('補正の対象科目に内部集約科目・残高調整科目は使えません', ap('accountId'));
        if (!counter) {
          issue('補正の相手科目が存在しません', ap('counterpartAccountId'));
        }
        if (adj.delta !== adj.actualBalance - adj.expectedBalance)
          issue('補正の delta が actual − expected と一致しません', ap('delta'));
        if (adj.delta === 0) issue('差額 0 の補正仕訳は保存できません', ap('delta'));
        if (e.kind !== 'normal')
          issue('補正仕訳の kind は normal である必要があります', ['journalEntries', ei, 'kind']);

        if (isAdjustableAccountType(targetType) && adj.delta !== 0 && counter) {
          const expectedCounterType = counterpartRole(targetType, adj.delta);
          // 同定は role + type のみ（name 非依存・指示書v3 §B-4）。name を要求すると
          // 生成時の言語（将来の en seed 等）が違う台帳を import で丸ごと拒否してしまう。
          if (counter.type !== expectedCounterType || counter.role !== 'system-adjustment') {
            issue(
              '補正の相手科目は対応する type の残高調整科目(system-adjustment)である必要があります',
              ap('counterpartAccountId'),
            );
          }

          // 向きは正規方向で決まる（asset と expense が同じ・liability と revenue が同じ）。
          // 相手 type（counterpartRole）とは別経路で導き、両方が一致する仕訳だけ受け入れる。
          const targetSide = (isDebitNormal(targetType) ? adj.delta > 0 : adj.delta < 0)
            ? 'debit'
            : 'credit';
          const counterpartSide = targetSide === 'debit' ? 'credit' : 'debit';
          const amount = Math.abs(adj.delta);
          const targetLine = e.lines.find((line) => line.accountId === adj.accountId);
          const counterpartLine = e.lines.find(
            (line) => line.accountId === adj.counterpartAccountId,
          );
          if (
            !targetLine ||
            targetLine.side !== targetSide ||
            targetLine.amount !== amount ||
            !counterpartLine ||
            counterpartLine.side !== counterpartSide ||
            counterpartLine.amount !== amount
          ) {
            issue('補正の仕訳明細が metadata の差額・科目と一致しません', [
              'journalEntries',
              ei,
              'lines',
            ]);
          }
        }
      }

      // 定期ルール由来の仕訳: ruleId と month は必ずペアで、ルールが存在すること
      // （ルール削除時はメタデータを剥がして通常仕訳へ戻す運用なので、存在は強制できる）。
      const rrId = e.metadata?.recurringRuleId;
      const rrMonth = e.metadata?.recurringMonth;
      const reservedEntryOrigin = parseRuleEntryId(e.id);
      if (
        reservedEntryOrigin !== undefined &&
        recurringRuleIdSet.has(reservedEntryOrigin.ruleId) &&
        (rrId !== reservedEntryOrigin.ruleId || rrMonth !== reservedEntryOrigin.month)
      ) {
        issue('現存する定期ルールの決定的仕訳 ID には対応する由来情報が必要です', [
          'journalEntries',
          ei,
          'id',
        ]);
      }
      if ((rrId !== undefined) !== (rrMonth !== undefined)) {
        issue('recurringRuleId と recurringMonth は必ずペアで持つ必要があります', [
          'journalEntries',
          ei,
          'metadata',
          'recurringRuleId',
        ]);
      }
      if (rrId !== undefined && !recurringRuleIdSet.has(rrId)) {
        issue(`仕訳の recurringRuleId(${rrId})が存在しません`, [
          'journalEntries',
          ei,
          'metadata',
          'recurringRuleId',
        ]);
      }
      if (rrId !== undefined && rrMonth !== undefined) {
        const recurringRule = recurringRuleById.get(rrId);
        if (e.id !== ruleEntryId(rrId, rrMonth)) {
          issue(`定期ルール由来仕訳の ID が起票月の決定的 ID と一致しません`, [
            'journalEntries',
            ei,
            'id',
          ]);
        }
        if (e.metadata?.monthlyCostRecovery === true) {
          issue('回収の仕訳に定期ルールの起票由来を付けることはできません', [
            'journalEntries',
            ei,
            'metadata',
            'recurringRuleId',
          ]);
        }
        if (rrMonth !== monthOf(e.date)) {
          issue(`定期ルール由来仕訳の日付(${e.date})と recurringMonth(${rrMonth})が一致しません`, [
            'journalEntries',
            ei,
            'metadata',
            'recurringMonth',
          ]);
        }
        if (recurringRule !== undefined && !ruleExistsAt(recurringRule, e.date)) {
          issue(
            `定期ルール由来仕訳の日付(${e.date})がルール「${recurringRule.name}」の存在期間外です`,
            ['journalEntries', ei, 'date'],
          );
        }
        const months = recurringPostingMonths.get(rrId) ?? new Set<string>();
        if (months.has(rrMonth)) {
          issue(`同じ定期ルール・月の仕訳が重複しています(${rrId}, ${rrMonth})`, [
            'journalEntries',
            ei,
            'metadata',
            'recurringMonth',
          ]);
        }
        months.add(rrMonth);
        recurringPostingMonths.set(rrId, months);
      }

      // 継続コスト由来の仕訳は、紐づく monthlyCostItem が存在すること。
      const mcId = e.metadata?.monthlyCostId;
      if (mcId !== undefined && !monthlyCostIdSet.has(mcId)) {
        issue(`仕訳の monthlyCostId(${mcId})が存在しません`, [
          'journalEntries',
          ei,
          'metadata',
          'monthlyCostId',
        ]);
      }

      // ── 継続コスト台帳の不変条件（⑧⑨: 台帳残高 = 残存価値 を守る最強の規則） ──
      const debitLine = e.lines.find((l) => l.side === 'debit');
      const creditLine = e.lines.find((l) => l.side === 'credit');
      const debitLedger = debitLine?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
      const creditLedger = creditLine?.accountId === CONTINUOUS_COST_LEDGER_ACCOUNT_ID;
      const isRecovery = e.metadata?.monthlyCostRecovery === true;
      // ⑧ 台帳を借方/貸方に持つ保存仕訳は必ず monthlyCostId を持つ
      //    （借方に台帳 = 購入の仕訳 / 貸方に台帳 = 回収の振替。この 2 種類しかない）。
      if ((debitLedger || creditLedger) && mcId === undefined) {
        issue(`継続コスト台帳にふれる仕訳「${e.description}」は monthlyCostId が必要です`, [
          'journalEntries',
          ei,
          'metadata',
          'monthlyCostId',
        ]);
      }
      // ⑨ 回収の振替は 貸方 = 台帳 かつ monthlyCostId 必須（回収額の上限は設けない＝
      //    割り振る総額が負になってよい。作者決定 2026-07-29）。
      //    借方は台帳自身を禁止（自己振替は回収集計だけを動かし「台帳残高 = 残存価値」を壊す）、
      //    振替先は簿記編集と同じく内部集約・残高調整以外の全 role、日付は購入（item.startDate）以降
      //    （購入前の期間に台帳が負になる断面を作らない。監査 P1-1）。
      if (isRecovery) {
        if (mcId === undefined) {
          issue(`回収の振替「${e.description}」は monthlyCostId が必要です`, [
            'journalEntries',
            ei,
            'metadata',
            'monthlyCostRecovery',
          ]);
        }
        if (!creditLedger) {
          issue(`回収の振替「${e.description}」は貸方が継続コスト台帳である必要があります`, [
            'journalEntries',
            ei,
            'lines',
          ]);
        }
        if (debitLedger) {
          issue(`回収の振替「${e.description}」の借方に継続コスト台帳は使えません`, [
            'journalEntries',
            ei,
            'lines',
          ]);
        } else {
          const debitRole = debitLine
            ? (accountRole.get(debitLine.accountId) as AccountRole | undefined)
            : undefined;
          if (!isRecurringPostableRole(debitRole)) {
            issue(
              `回収の振替「${e.description}」の振替先は内部集約・残高調整以外の科目である必要があります`,
              ['journalEntries', ei, 'lines'],
            );
          }
        }
        const recoveryItem = mcId !== undefined ? monthlyCostById.get(mcId) : undefined;
        if (recoveryItem && e.date < recoveryItem.startDate) {
          issue(
            `回収の振替「${e.description}」の日付(${e.date})が開始日(${recoveryItem.startDate})より前です`,
            ['journalEntries', ei, 'date'],
          );
        }
      }
      // ⑦（前半）購入の仕訳の形: 借方 = 継続コスト台帳・貸方（支払い元）は起票可能な全 role
      // （RECURRING_POSTABLE_ROLES = 内部集約・残高調整以外。equity=初期残高も含む）。
      if (mcId !== undefined && !isRecovery) {
        if (!debitLedger) {
          issue(`購入の仕訳「${e.description}」は借方が継続コスト台帳である必要があります`, [
            'journalEntries',
            ei,
            'lines',
          ]);
        }
        const creditRole = creditLine
          ? (accountRole.get(creditLine.accountId) as AccountRole | undefined)
          : undefined;
        if (!isRecurringPostableRole(creditRole)) {
          issue(`購入の仕訳「${e.description}」の貸方に内部集約・残高調整の科目は使えません`, [
            'journalEntries',
            ei,
            'lines',
          ]);
        }
        const list = purchaseEntriesByItem.get(mcId) ?? [];
        list.push(e);
        purchaseEntriesByItem.set(mcId, list);
      }
    });

    // 定期ルール(recurringRules)の参照整合性。
    const seenRuleIds = new Set<string>();
    pkg.recurringRules.forEach((r, ri) => {
      const at = (...p: (string | number)[]) => ['recurringRules', ri, ...p];
      if (seenRuleIds.has(r.id)) issue(`定期ルールの ID が重複しています(${r.id})`, at('id'));
      seenRuleIds.add(r.id);
      if (!hasAccount(r.debitAccountId))
        issue(`定期ルール「${r.name}」の行き先科目が存在しません`, at('debitAccountId'));
      if (!hasAccount(r.creditAccountId))
        issue(`定期ルール「${r.name}」の源泉科目が存在しません`, at('creditAccountId'));
      if (r.debitAccountId === r.creditAccountId)
        issue(`定期ルール「${r.name}」の源泉と行き先が同一です`, at('debitAccountId'));
      if ((r.spreadExpenseAccountId ?? r.debitAccountId) === r.creditAccountId)
        issue(
          `定期ルール「${r.name}」の源泉と論理的な行き先が同一です`,
          at(r.spreadExpenseAccountId !== undefined ? 'spreadExpenseAccountId' : 'debitAccountId'),
        );
      const debitPostable = isRecurringPostableRole(
        accountRole.get(r.debitAccountId) as AccountRole | undefined,
      );
      const creditPostable = isRecurringPostableRole(
        accountRole.get(r.creditAccountId) as AccountRole | undefined,
      );
      if (r.spreadExpenseAccountId !== undefined) {
        // 月割りトグル ON の保存形: 借方 = 継続コスト台帳（rule schema で確認済み）、
        // spread = 計上先。計上先は自動起票できる全 role を許す（勘定科目で動作を変えない）。
        if (hasAccount(r.creditAccountId) && !creditPostable)
          issue(
            `定期ルール「${r.name}」の源泉科目は定期ルールに使えません（内部集約・調整科目は自動起票できません）`,
            at('creditAccountId'),
          );
        if (!hasAccount(r.spreadExpenseAccountId))
          issue(`定期ルール「${r.name}」の計上先が存在しません`, at('spreadExpenseAccountId'));
        else if (
          !isRecurringPostableRole(
            accountRole.get(r.spreadExpenseAccountId) as AccountRole | undefined,
          )
        )
          issue(
            `定期ルール「${r.name}」の計上先に内部集約・残高調整の科目は使えません`,
            at('spreadExpenseAccountId'),
          );
      } else if (
        hasAccount(r.debitAccountId) &&
        hasAccount(r.creditAccountId) &&
        (!debitPostable || !creditPostable)
      ) {
        // 支出/収入/振替の定型に加え簿記編集（任意の科目ペア）を許容する。内部集約・調整科目
        // だけは自動起票の対象外（RECURRING_POSTABLE_ROLES が正本）。
        // 月割りトグル OFF なら費用・収入行きも直接形が正規の保存形。
        issue(
          `定期ルール「${r.name}」の科目は定期ルールに使えません（内部集約・調整科目は自動起票できません）`,
          at('debitAccountId'),
        );
      }
    });

    // splitFromRuleId でつながる同一系譜では、半開存在期間が互いに重ならない。
    // 境界の一致・後継数・周期 anchor は個別に拘束せず、存在期間の1不変条件へ集約する。
    for (const violation of recurringLineageViolations(pkg.recurringRules)) {
      const ri = pkg.recurringRules.findIndex((rule) => rule.id === violation.ruleId);
      const rule = pkg.recurringRules[ri];
      if (!rule) continue;
      if (violation.kind === 'overlap') {
        issue(`定期ルール「${rule.name}」の存在期間が同じ系譜の別ルールと重なっています`, [
          'recurringRules',
          ri,
          'startDate',
        ]);
      } else {
        issue(`定期ルール「${rule.name}」の分割元参照が不正です`, [
          'recurringRules',
          ri,
          'splitFromRuleId',
        ]);
      }
    }

    // 継続コスト資産(monthlyCostItems)の参照整合性。
    const monthlyCostIds = new Set<string>();
    pkg.monthlyCostItems.forEach((mc, mi) => {
      const at = (...p: (string | number)[]) => ['monthlyCostItems', mi, ...p];
      if (monthlyCostIds.has(mc.id)) issue(`継続コストの ID が重複しています(${mc.id})`, at('id'));
      monthlyCostIds.add(mc.id);

      // 費用の行き先: 内部集約・残高調整以外の勘定科目（定期ルールと同じ正本）。
      if (!accountType.has(mc.expenseAccountId))
        issue(`継続コスト「${mc.name}」の expenseAccountId が存在しません`, at('expenseAccountId'));
      else if (
        !isRecurringPostableRole(accountRole.get(mc.expenseAccountId) as AccountRole | undefined)
      )
        issue(
          `継続コスト「${mc.name}」の expenseAccountId に内部集約・残高調整の科目は使えません`,
          at('expenseAccountId'),
        );

      // 購入の仕訳がちょうど 1 件・金額と日付が item と完全一致（日レベル。
      // 月レベルにすると初月クランプが効かず台帳マイナスが再発する）。
      const purchases = purchaseEntriesByItem.get(mc.id) ?? [];
      if (purchases.length !== 1) {
        issue(
          `継続コスト「${mc.name}」の購入の仕訳がちょうど 1 件必要です（現在 ${purchases.length} 件）`,
          at('id'),
        );
      } else {
        const purchase = purchases[0]!;
        if (purchase.date !== mc.startDate)
          issue(
            `継続コスト「${mc.name}」の開始日(${mc.startDate})が購入の仕訳の日付(${purchase.date})と一致しません`,
            at('startDate'),
          );
        const debitAmount = purchase.lines.find((l) => l.side === 'debit')?.amount;
        if (debitAmount !== mc.amount)
          issue(
            `継続コスト「${mc.name}」の金額(${mc.amount})が購入の仕訳の金額(${debitAmount})と一致しません`,
            at('amount'),
          );

        const purchaseRuleId = purchase.metadata?.recurringRuleId;
        const purchaseRuleMonth = purchase.metadata?.recurringMonth;
        const purchaseRule =
          purchaseRuleId !== undefined ? recurringRuleById.get(purchaseRuleId) : undefined;
        if (
          purchaseRule !== undefined &&
          purchaseRuleMonth !== undefined &&
          // 月割りするルール = 保存形（spread の有無）。role からは再導出しない。
          purchaseRule.spreadExpenseAccountId !== undefined &&
          mc.id !== ruleItemId(purchaseRule.id, purchaseRuleMonth)
        ) {
          issue(
            `月割りルール由来の継続コスト「${mc.name}」は対応する決定的 ID が必要です`,
            at('id'),
          );
        }
      }

      const ccr = parseRuleItemId(mc.id);
      if (ccr) {
        const { ruleId, month: postingMonth } = ccr;
        const recurringRule = recurringRuleById.get(ruleId);
        // 物理削除時は item を通常 ID へ付け替える。ccr ID のままなら由来ルールが必須。
        if (recurringRule === undefined) {
          issue(`継続コスト「${mc.name}」の由来ルール(${ruleId})が存在しません`, at('id'));
        } else if (!ruleExistsAt(recurringRule, mc.startDate)) {
          issue(
            `継続コスト「${mc.name}」の作成日(${mc.startDate})が定期ルールの存在期間外です`,
            at('startDate'),
          );
        }
        if (postingMonth !== monthOf(mc.startDate)) {
          issue(
            `継続コスト「${mc.name}」の作成月(${monthOf(mc.startDate)})が ID の起票月(${postingMonth})と一致しません`,
            at('startDate'),
          );
        }
        const purchase = purchases.length === 1 ? purchases[0] : undefined;
        if (
          purchase !== undefined &&
          (purchase.metadata?.recurringRuleId !== ruleId ||
            purchase.metadata?.recurringMonth !== postingMonth)
        ) {
          issue(
            `ルール由来の継続コスト「${mc.name}」の購入仕訳に対応するルール/月の由来がありません`,
            at('id'),
          );
        }
      }
    });

    // 科目の存在期間は、明示された端点だけを import 境界で検証する。
    // 定期ルールの startDate は schema v6 で必須。旧版 JSON は読み替えず版境界で拒否する。
    // 定期ルールは半開の存在期間を、科目参照では排他的終了日の前日までの有限区間へ変換する。
    // 終了日のないルールだけは、参照科目にも終了点なしの開区間を要求する。
    const lifetimeCollections = {
      entries: pkg.journalEntries,
      monthlyCostItems: pkg.monthlyCostItems,
      recurringRules: pkg.recurringRules,
    };
    pkg.accounts.forEach((account, ai) => {
      const violation = accountLifetimeViolation(
        account,
        accountReferenceIntervals(account.id, lifetimeCollections),
      );
      if (!violation) return;
      const edge = violation.edge === 'start' ? '開始日' : '終了日';
      const referenceEnd =
        violation.reference.to === undefined ? '終了なし' : `${violation.reference.to}まで`;
      issue(
        `勘定科目「${account.name}」の${edge}が参照期間(${violation.reference.from}から${referenceEnd})を包含していません`,
        ['accounts', ai, violation.edge === 'start' ? 'startDate' : 'endDate'],
      );
    });

    // 終了点を持つ資産・負債は、その endDate 時点で導出込み残高 0。費用・収入の累計は
    // 過去の記録なのでこの条件を課さない（作者決定 2026-07-31）。
    const accountIndex = new Map(pkg.accounts.map((account, index) => [account.id, index]));
    for (const violation of accountEndingBalanceViolations({
      accounts: pkg.accounts,
      journalEntries: pkg.journalEntries,
      monthlyCostItems: pkg.monthlyCostItems,
      recurringRules: pkg.recurringRules,
    })) {
      issue(`終了済みの資産・負債科目「${violation.account.name}」の終了点残高が0ではありません`, [
        'accounts',
        accountIndex.get(violation.account.id) ?? 0,
        'endDate',
      ]);
    }

    // タグ(tags): id 一意 + active な同名重複なし + 参照整合。機能は撤去済みだが、
    // 受理したデータをそのまま往復させる以上、交換の不変条件は v12 のまま守る。
    const tagIds = new Set<string>();
    const activeNames = new Set<string>();
    pkg.tags.forEach((tag, ti) => {
      if (tagIds.has(tag.id)) issue(`タグ ID が重複しています(${tag.id})`, ['tags', ti, 'id']);
      tagIds.add(tag.id);
      if (!tag.archived) {
        if (activeNames.has(tag.name))
          issue(`同名の有効なタグが重複しています(${tag.name})`, ['tags', ti, 'name']);
        activeNames.add(tag.name);
      }
    });

    const checkTags = (ids: string[] | undefined, path: (string | number)[]) => {
      ids?.forEach((id, i) => {
        if (!tagIds.has(id)) issue(`存在しないタグ(${id})を参照しています`, [...path, i]);
      });
    };

    pkg.journalEntries.forEach((e, ei) => {
      checkTags(e.tagIds, ['journalEntries', ei, 'tagIds']);
    });
  });

export type LedgerExportPackageInput = z.infer<typeof ledgerExportPackageSchema>;
