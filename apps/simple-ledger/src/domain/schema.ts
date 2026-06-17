/*
 * Zod スキーマ。import 時の境界検証はすべてここを通す。
 * 型は src/domain/types.ts と一致させる（z.infer で照合可能）。
 */
import { z } from 'zod';
import {
  APP_ID,
  CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
  RESERVE_LEDGER_ACCOUNT_ID,
  SCHEMA_VERSION,
} from './constants';
import { addMonths, monthlyAmounts } from './allocation';
import {
  ACCOUNT_ROLES,
  isInstrumentParentRole,
  roleAllowsType,
  type AccountRole,
} from './accountRoles';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式である必要があります');

const isoDateTime = z.string().min(1);

export const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);

export const sideSchema = z.enum(['debit', 'credit']);

/** 金額: 正の整数（最小通貨単位）。 */
const amountSchema = z
  .number()
  .int('金額は整数で入力してください')
  .positive('金額は 1 以上で入力してください')
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
    archived: z.boolean(),
    note: z.string().max(500).optional(),
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
  });

const tagIdList = z.array(z.string().min(1));

export const journalLineSchema = z.object({
  accountId: z.string().min(1),
  side: sideSchema,
  amount: amountSchema,
  /** 支払い手段の細目（任意）。参照整合は export パッケージ側で検証する。 */
  instrumentId: z.string().min(1).optional(),
});

// タグは「仕訳全体のみ」。明細・両方 scope は廃止。
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

export const managementScopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  archived: z.boolean().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const accountInstrumentKindSchema = z.enum(['bank', 'card', 'prepaid', 'cash', 'other']);

export const accountInstrumentSchema = z.object({
  id: z.string().min(1),
  managementScopeId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: accountInstrumentKindSchema,
  archived: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const inputModeSchema = z.enum(['income', 'expense', 'transfer', 'manual', 'reversal']);

export const allocationPlanSchema = z.object({
  kind: z.literal('period'),
  startDate: isoDate,
  endDate: isoDate,
  method: z.enum(['even-monthly']),
  recognitionAccountId: z.string().min(1),
  deferredAccountId: z.string().min(1),
  generatedEntryIds: z.array(z.string().min(1)),
});

export const adjustmentMetaSchema = z.object({
  kind: z.enum(['unknown-balance', 'investment-valuation']),
  accountId: z.string().min(1),
  expectedBalance: z.number().int().finite(),
  actualBalance: z.number().int().finite(),
  delta: z.number().int().finite(),
  counterpartAccountId: z.string().min(1),
});

export const entryMetadataSchema = z.object({
  inputMode: inputModeSchema.optional(),
  reversalOfEntryId: z.string().min(1).optional(),
  allocationPlan: allocationPlanSchema.optional(),
  allocationId: z.string().min(1).optional(),
  allocationRole: z.enum(['source', 'recognition']).optional(),
  adjustment: adjustmentMetaSchema.optional(),
  monthlyCostId: z.string().min(1).optional(),
  assetDisposalId: z.string().min(1).optional(),
  reserveId: z.string().min(1).optional(),
});

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, '月は YYYY-MM 形式である必要があります');

export const allocationItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  totalAmount: amountSchema,
  months: z.number().int().min(2),
  startMonth: monthSchema,
  expenseAccountId: z.string().min(1),
  paymentAccountId: z.string().min(1),
  deferredAccountId: z.string().min(1),
  sourceEntryId: z.string().min(1),
  recognitionEntryIds: z.array(z.string().min(1)),
  status: z.enum(['active', 'completed', 'disposed', 'settled']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const cashflowScheduleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  dueDate: isoDate,
  amount: amountSchema,
  direction: z.enum(['inflow', 'outflow', 'transfer']),
  accountId: z.string().min(1),
  counterAccountId: z.string().min(1).optional(),
  source: z.enum(['manual', 'credit-card', 'installment', 'reserve']),
  status: z.enum(['planned', 'posted', 'cancelled']),
  managementScopeId: z.string().min(1),
  linkedEntryId: z.string().min(1).optional(),
  entryTagIds: tagIdList.optional(),
  monthlyCostId: z.string().min(1).optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const reserveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  reserveAccountId: z.string().min(1),
  parentAccountId: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const monthlyCostItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  managementScopeId: z.string().min(1),
  kind: z.enum(['subscription', 'prepaid-service', 'durable-asset', 'recurring-event']),
  amount: amountSchema,
  costMonths: z.number().int().min(1),
  repeatEveryMonths: z.number().int().min(1).optional(),
  startMonth: monthSchema,
  endMonth: monthSchema.optional(),
  expenseAccountId: z.string().min(1),
  paymentSourceAccountId: z.string().min(1).optional(),
  paymentAccountId: z.string().min(1).optional(),
  repaymentAccountId: z.string().min(1).optional(),
  sourceAllocationId: z.string().min(1).optional(),
  sourceEntryId: z.string().min(1).optional(),
  recognitionCreditAccountId: z.string().min(1).optional(),
  status: z.enum(['active', 'paused', 'ended']),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const assetDisposalSchema = z.object({
  id: z.string().min(1),
  monthlyCostId: z.string().min(1),
  fixedAccountId: z.string().min(1),
  managementScopeId: z.string().min(1),
  disposalDate: isoDate,
  proceedsAmount: z.number().int().nonnegative(),
  destinationAccountId: z.string().min(1).optional(),
  recognizedAmount: z.number().int().nonnegative(),
  remainingAmount: z.number().int().nonnegative(),
  generatedEntryIds: z.array(z.string().min(1)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const journalEntrySchema = z
  .object({
    id: z.string().min(1),
    date: isoDate,
    description: z.string().min(1).max(200),
    lines: z.array(journalLineSchema).min(2),
    memo: z.string().max(1000).optional(),
    kind: z.enum(['normal', 'opening']),
    managementScopeId: z.string().min(1),
    metadata: entryMetadataSchema.optional(),
    tagIds: tagIdList.optional(),
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
  ledgerName: z.string().min(1).max(120),
  currency: z.string().min(1).max(8),
  locale: z.literal('ja'),
});

/**
 * エクスポートパッケージ。import の入口検証。
 * appId / schemaVersion は厳格に確認する（未対応版は取り込まない=fail-closed）。
 */
export const ledgerExportPackageSchema = z
  .object({
    appId: z.literal(APP_ID),
    schemaVersion: z.number().int().positive(),
    ledgerId: z.string().min(1),
    exportedAt: isoDateTime,
    deviceId: z.string().min(1),
    // foundation 封筒の revision（楽観的衝突検出）。v2 では必須（無いファイルは取り込まない）。
    revision: z.number().int().nonnegative(),
    managementScopes: z.array(managementScopeSchema),
    accountInstruments: z.array(accountInstrumentSchema),
    accounts: z.array(accountSchema),
    journalEntries: z.array(journalEntrySchema),
    allocations: z.array(allocationItemSchema),
    cashflowSchedules: z.array(cashflowScheduleSchema),
    reserves: z.array(reserveItemSchema),
    tags: z.array(tagSchema),
    monthlyCostItems: z.array(monthlyCostItemSchema),
    assetDisposals: z.array(assetDisposalSchema),
    settings: settingsSchema,
  })
  .superRefine((pkg, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // 勘定科目 ID は一意 + type / role マップ。
    // 有効（非アーカイブ）な内訳名は箱をまたいでも重複不可（通常保存の upsertAccount と同じ
    // 不変条件。これがないと import / 復元が重複名の抜け道になる）。アーカイブ済みは対象外
    // （アーカイブ解除時に保存境界の nameConflict で弾かれる）。
    const accountType = new Map<string, string>();
    const accountRole = new Map<string, string>();
    const activeAccountNames = new Set<string>();
    pkg.accounts.forEach((a, i) => {
      if (accountType.has(a.id))
        issue(`勘定科目 ID が重複しています(${a.id})`, ['accounts', i, 'id']);
      accountType.set(a.id, a.type);
      accountRole.set(a.id, a.role);
      if (!a.archived) {
        // 空白違いの同名（例: 「預金」と「預金 」）を別名にしないよう trim 後で比較する。
        const trimmedName = a.name.trim();
        if (activeAccountNames.has(trimmedName))
          issue(`同名の有効な勘定科目が重複しています(${trimmedName})`, ['accounts', i, 'name']);
        activeAccountNames.add(trimmedName);
      }
      // 集約モデルの不変条件（聖域化）: 内部集約ロールは唯一の集約口座 id のみ許す。
      // これがないと import で目的別の reserve-asset / continuing-cost-asset 科目を再導入できてしまう。
      if (a.role === 'reserve-asset' && a.id !== RESERVE_LEDGER_ACCOUNT_ID)
        issue(
          `取り置き資金(reserve-asset)は集約口座(${RESERVE_LEDGER_ACCOUNT_ID})のみ許可されます（目的別の科目は作れません）`,
          ['accounts', i, 'id'],
        );
      if (a.role === 'continuing-cost-asset' && a.id !== CONTINUOUS_COST_LEDGER_ACCOUNT_ID)
        issue(
          `継続コスト台帳(continuing-cost-asset)は集約口座(${CONTINUOUS_COST_LEDGER_ACCOUNT_ID})のみ許可されます`,
          ['accounts', i, 'id'],
        );
    });
    const hasAccount = (id: string) => accountType.has(id);

    // 管理区分 ID は一意。
    const scopeIds = new Set<string>();
    pkg.managementScopes.forEach((s, i) => {
      if (scopeIds.has(s.id))
        issue(`管理区分 ID が重複しています(${s.id})`, ['managementScopes', i, 'id']);
      scopeIds.add(s.id);
    });
    const hasScope = (id: string) => scopeIds.has(id);

    // 支払い手段の細目: ID 一意 + 管理区分・親科目の参照整合。account を引く map も作る。
    const instrumentById = new Map<string, (typeof pkg.accountInstruments)[number]>();
    pkg.accountInstruments.forEach((inst, i) => {
      const at = (...p: (string | number)[]) => ['accountInstruments', i, ...p];
      if (instrumentById.has(inst.id))
        issue(`支払い手段 ID が重複しています(${inst.id})`, at('id'));
      instrumentById.set(inst.id, inst);
      if (!hasScope(inst.managementScopeId))
        issue(`支払い手段「${inst.name}」の管理区分が存在しません`, at('managementScopeId'));
      if (!hasAccount(inst.accountId))
        issue(`支払い手段「${inst.name}」の親科目が存在しません`, at('accountId'));
      else if (!isInstrumentParentRole(accountRole.get(inst.accountId) as AccountRole))
        issue(
          `支払い手段「${inst.name}」の親科目は資金口座またはクレジットカードに限られます`,
          at('accountId'),
        );
    });

    // 月額化コスト ID 集合（仕訳・予定CF の monthlyCostId 参照検証に使う）。
    const monthlyCostIdSet = new Set(pkg.monthlyCostItems.map((m) => m.id));
    // 固定資産処分 ID 集合（仕訳の assetDisposalId 参照検証に使う）。
    const assetDisposalIdSet = new Set(pkg.assetDisposals.map((d) => d.id));

    // 仕訳 ID は一意 + map。
    const entryById = new Map<string, (typeof pkg.journalEntries)[number]>();
    pkg.journalEntries.forEach((e, ei) => {
      if (entryById.has(e.id))
        issue(`仕訳 ID が重複しています(${e.id})`, ['journalEntries', ei, 'id']);
      entryById.set(e.id, e);
    });

    // 参照整合性: すべての仕訳明細の accountId が accounts に存在すること。
    pkg.journalEntries.forEach((e, ei) => {
      // 管理区分の参照整合。
      if (!hasScope(e.managementScopeId))
        issue(`仕訳「${e.description}」の管理区分が存在しません`, [
          'journalEntries',
          ei,
          'managementScopeId',
        ]);

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
        // 支払い手段の細目: 存在 + 親科目一致 + 管理区分一致。
        if (l.instrumentId !== undefined) {
          const inst = instrumentById.get(l.instrumentId);
          const lp = (field: string) => ['journalEntries', ei, 'lines', li, field];
          if (!inst)
            issue(`仕訳「${e.description}」の支払い手段が存在しません`, lp('instrumentId'));
          else {
            if (inst.accountId !== l.accountId)
              issue(`支払い手段「${inst.name}」が明細の科目と一致しません`, lp('instrumentId'));
            if (inst.managementScopeId !== e.managementScopeId)
              issue(`支払い手段「${inst.name}」が仕訳の管理区分と一致しません`, lp('instrumentId'));
          }
        }
      });

      // allocationId と allocationRole は必ず同時に存在する（role 単独で按分認識額へ
      // 混ざるのを防ぐ。さらに後段の孤立チェックで AllocationItem 参照も必須にする）。
      const hasAllocId = e.metadata?.allocationId !== undefined;
      const hasAllocRole = e.metadata?.allocationRole !== undefined;
      if (hasAllocId !== hasAllocRole) {
        issue('allocationId と allocationRole は同時に指定する必要があります', [
          'journalEntries',
          ei,
          'metadata',
        ]);
      }

      // 按分計画(allocationPlan)の参照整合性（将来拡張の土台でも壊れた参照は取り込まない）。
      const plan = e.metadata?.allocationPlan;
      if (plan) {
        (
          [
            ['recognitionAccountId', plan.recognitionAccountId],
            ['deferredAccountId', plan.deferredAccountId],
          ] as const
        ).forEach(([field, id]) => {
          if (!hasAccount(id)) {
            issue(`按分計画の ${field} が存在しない勘定科目(${id})を参照しています`, [
              'journalEntries',
              ei,
              'metadata',
              'allocationPlan',
              field,
            ]);
          }
        });
        plan.generatedEntryIds.forEach((gid, gi) => {
          if (!entryById.has(gid)) {
            issue(`按分計画の生成仕訳 ID(${gid})が存在しません`, [
              'journalEntries',
              ei,
              'metadata',
              'allocationPlan',
              'generatedEntryIds',
              gi,
            ]);
          }
        });
      }

      // 残高補正(adjustment)の参照整合性 + delta の一貫性。
      const adj = e.metadata?.adjustment;
      if (adj) {
        const ap = (field: string) => ['journalEntries', ei, 'metadata', 'adjustment', field];
        if (!hasAccount(adj.accountId)) issue('補正の対象科目が存在しません', ap('accountId'));
        if (!hasAccount(adj.counterpartAccountId))
          issue('補正の相手科目が存在しません', ap('counterpartAccountId'));
        if (adj.delta !== adj.actualBalance - adj.expectedBalance)
          issue('補正の delta が actual − expected と一致しません', ap('delta'));
      }

      // 月額化コスト由来の仕訳は、紐づく monthlyCostItem が存在すること。
      const mcId = e.metadata?.monthlyCostId;
      if (mcId !== undefined && !monthlyCostIdSet.has(mcId)) {
        issue(`仕訳の monthlyCostId(${mcId})が存在しません`, [
          'journalEntries',
          ei,
          'metadata',
          'monthlyCostId',
        ]);
      }
      // 固定資産処分で生成された仕訳は、紐づく assetDisposal が存在すること。
      const adId = e.metadata?.assetDisposalId;
      if (adId !== undefined && !assetDisposalIdSet.has(adId)) {
        issue(`仕訳の assetDisposalId(${adId})が存在しません`, [
          'journalEntries',
          ei,
          'metadata',
          'assetDisposalId',
        ]);
      }
    });

    // 按分支出(allocations)の深い整合性検証。壊れた JSON を取り込まない。
    const allocationIds = new Set<string>();
    const claimedEntryIds = new Set<string>();
    pkg.allocations.forEach((al, ai) => {
      const at = (...p: (string | number)[]) => ['allocations', ai, ...p];
      if (allocationIds.has(al.id)) issue(`按分 ID が重複しています(${al.id})`, at('id'));
      allocationIds.add(al.id);
      claimedEntryIds.add(al.sourceEntryId);
      al.recognitionEntryIds.forEach((rid) => claimedEntryIds.add(rid));

      // 科目の存在と type（expense=費用 / payment=資産か負債 / deferred=資産）+ role 整合。
      const expType = accountType.get(al.expenseAccountId);
      if (expType === undefined)
        issue(`按分「${al.name}」の expenseAccountId が存在しません`, at('expenseAccountId'));
      else if (expType !== 'expense')
        issue(
          `按分「${al.name}」の expenseAccountId は費用科目である必要があります`,
          at('expenseAccountId'),
        );
      else if (accountRole.get(al.expenseAccountId) !== 'expense-category')
        issue(
          `按分「${al.name}」の expenseAccountId は支出カテゴリ(expense-category)である必要があります`,
          at('expenseAccountId'),
        );

      const payType = accountType.get(al.paymentAccountId);
      const payRole = accountRole.get(al.paymentAccountId);
      if (payType === undefined)
        issue(`按分「${al.name}」の paymentAccountId が存在しません`, at('paymentAccountId'));
      else if (payType !== 'asset' && payType !== 'liability')
        issue(
          `按分「${al.name}」の paymentAccountId は資産または負債である必要があります`,
          at('paymentAccountId'),
        );
      else if (payRole !== 'daily-asset' && payRole !== 'payment-liability')
        issue(
          `按分「${al.name}」の paymentAccountId は日常資産または支払用負債である必要があります`,
          at('paymentAccountId'),
        );

      const defType = accountType.get(al.deferredAccountId);
      if (defType === undefined)
        issue(`按分「${al.name}」の deferredAccountId が存在しません`, at('deferredAccountId'));
      else if (defType !== 'asset')
        issue(
          `按分「${al.name}」の deferredAccountId は資産科目である必要があります`,
          at('deferredAccountId'),
        );
      else if (accountRole.get(al.deferredAccountId) !== 'deferred-asset')
        issue(
          `按分「${al.name}」の deferredAccountId は按分中資産(deferred-asset)である必要があります`,
          at('deferredAccountId'),
        );

      // 計上仕訳の本数 = months、ID 重複なし。
      if (al.recognitionEntryIds.length !== al.months) {
        issue(
          `按分「${al.name}」の計上仕訳数(${al.recognitionEntryIds.length})が按分月数(${al.months})と一致しません`,
          at('recognitionEntryIds'),
        );
      }
      if (new Set(al.recognitionEntryIds).size !== al.recognitionEntryIds.length) {
        issue(`按分「${al.name}」の計上仕訳 ID が重複しています`, at('recognitionEntryIds'));
      }

      // 原始仕訳: メタ一致 + 借方 deferred / 貸方 payment / 金額 totalAmount。
      const src = entryById.get(al.sourceEntryId);
      if (!src) {
        issue(
          `按分「${al.name}」の原始仕訳(${al.sourceEntryId})が存在しません`,
          at('sourceEntryId'),
        );
      } else {
        if (src.metadata?.allocationId !== al.id || src.metadata?.allocationRole !== 'source')
          issue(`按分「${al.name}」の原始仕訳のメタ情報が一致しません`, at('sourceEntryId'));
        const d = src.lines.find((l) => l.side === 'debit');
        const c = src.lines.find((l) => l.side === 'credit');
        if (
          d?.accountId !== al.deferredAccountId ||
          c?.accountId !== al.paymentAccountId ||
          d?.amount !== al.totalAmount
        ) {
          issue(
            `按分「${al.name}」の原始仕訳の借方/貸方/金額が定義と一致しません`,
            at('sourceEntryId'),
          );
        }
      }

      // 月次計上仕訳: メタ・借方 expense / 貸方 deferred・金額列・日付列・合計が定義どおり。
      const amounts = monthlyAmounts(al.totalAmount, al.months);
      let sum = 0;
      let allRecognitionOk = al.recognitionEntryIds.length === al.months;
      al.recognitionEntryIds.forEach((rid, i) => {
        const re = entryById.get(rid);
        if (!re) {
          issue(`按分「${al.name}」の計上仕訳(${rid})が存在しません`, at('recognitionEntryIds', i));
          allRecognitionOk = false;
          return;
        }
        if (re.metadata?.allocationId !== al.id || re.metadata?.allocationRole !== 'recognition')
          issue(
            `按分「${al.name}」の計上仕訳のメタ情報が一致しません`,
            at('recognitionEntryIds', i),
          );
        const d = re.lines.find((l) => l.side === 'debit');
        const c = re.lines.find((l) => l.side === 'credit');
        const expectedDate = `${addMonths(al.startMonth, i)}-01`;
        if (
          d?.accountId !== al.expenseAccountId ||
          c?.accountId !== al.deferredAccountId ||
          d?.amount !== amounts[i] ||
          re.date !== expectedDate
        ) {
          issue(
            `按分「${al.name}」の計上仕訳の科目/金額/日付が定義と一致しません`,
            at('recognitionEntryIds', i),
          );
          allRecognitionOk = false;
        }
        if (d) sum += d.amount;
      });
      if (allRecognitionOk && sum !== al.totalAmount) {
        issue(
          `按分「${al.name}」の計上仕訳の合計(${sum})が総額(${al.totalAmount})と一致しません`,
          at('recognitionEntryIds'),
        );
      }
    });

    // 孤立した按分仕訳（どの AllocationItem からも参照されない allocationId 付き仕訳）。
    pkg.journalEntries.forEach((e, ei) => {
      if (e.metadata?.allocationId && !claimedEntryIds.has(e.id)) {
        issue(`按分仕訳「${e.description}」がどの按分台帳からも参照されていません`, [
          'journalEntries',
          ei,
          'metadata',
          'allocationId',
        ]);
      }
    });

    // 予定キャッシュフロー(cashflowSchedules)の参照整合性。
    const scheduleIds = new Set<string>();
    pkg.cashflowSchedules.forEach((s, si) => {
      const at = (...p: (string | number)[]) => ['cashflowSchedules', si, ...p];
      if (scheduleIds.has(s.id)) issue(`予定 CF の ID が重複しています(${s.id})`, at('id'));
      scheduleIds.add(s.id);
      if (!hasScope(s.managementScopeId))
        issue(`予定 CF「${s.title}」の管理区分が存在しません`, at('managementScopeId'));
      const accType = accountType.get(s.accountId);
      if (accType === undefined)
        issue(`予定 CF「${s.title}」の口座が存在しません`, at('accountId'));
      else if (accType !== 'asset')
        issue(`予定 CF「${s.title}」の口座は資産科目である必要があります`, at('accountId'));
      if (s.counterAccountId !== undefined && !accountType.has(s.counterAccountId))
        issue(`予定 CF「${s.title}」の相手科目が存在しません`, at('counterAccountId'));
      if (
        s.status === 'posted' &&
        (s.linkedEntryId === undefined || !entryById.has(s.linkedEntryId))
      )
        issue(
          `posted の予定 CF「${s.title}」は存在する仕訳に紐づく必要があります`,
          at('linkedEntryId'),
        );
      if (s.monthlyCostId !== undefined && !monthlyCostIdSet.has(s.monthlyCostId))
        issue(`予定 CF「${s.title}」の monthlyCostId が存在しません`, at('monthlyCostId'));
    });

    // 目的別資金(reserves)の参照整合性。
    const reserveIds = new Set<string>();
    pkg.reserves.forEach((r, ri) => {
      const at = (...p: (string | number)[]) => ['reserves', ri, ...p];
      if (reserveIds.has(r.id)) issue(`目的別資金の ID が重複しています(${r.id})`, at('id'));
      reserveIds.add(r.id);
      const accType = accountType.get(r.reserveAccountId);
      if (accType === undefined)
        issue(`目的別資金「${r.name}」の科目が存在しません`, at('reserveAccountId'));
      else if (accType !== 'asset')
        issue(
          `目的別資金「${r.name}」の科目は資産科目である必要があります`,
          at('reserveAccountId'),
        );
      else if (accountRole.get(r.reserveAccountId) !== 'reserve-asset')
        issue(
          `目的別資金「${r.name}」の科目は目的別資金(reserve-asset)である必要があります`,
          at('reserveAccountId'),
        );
      else if (r.reserveAccountId !== RESERVE_LEDGER_ACCOUNT_ID)
        issue(
          `目的別資金「${r.name}」は集約口座(${RESERVE_LEDGER_ACCOUNT_ID})に寄せる必要があります（目的別の科目は作れません）`,
          at('reserveAccountId'),
        );
      // 親口座（取り置き元）は任意。あれば日常資産(daily-asset)であること。
      if (r.parentAccountId !== undefined) {
        if (!accountType.has(r.parentAccountId))
          issue(`目的別資金「${r.name}」の取り置き元口座が存在しません`, at('parentAccountId'));
        else if (accountRole.get(r.parentAccountId) !== 'daily-asset')
          issue(
            `目的別資金「${r.name}」の取り置き元口座は日常資産である必要があります`,
            at('parentAccountId'),
          );
      }
    });

    // 集約モデルの不変条件: 取り置きの仕訳タグ(metadata.reserveId)は既存の ReserveItem を参照し、
    // かつ集約口座(reserve-ledger)に触れていること（目的別残高がタグ集計で正しく導出できる）。
    pkg.journalEntries.forEach((e, ei) => {
      const rid = e.metadata?.reserveId;
      if (rid === undefined) return;
      if (!reserveIds.has(rid))
        issue(`仕訳の reserveId(${rid}) が存在しない取り置きを参照しています`, [
          'journalEntries',
          ei,
          'metadata',
          'reserveId',
        ]);
      if (!e.lines.some((l) => l.accountId === RESERVE_LEDGER_ACCOUNT_ID))
        issue(
          `reserveId 付きの仕訳は集約口座(${RESERVE_LEDGER_ACCOUNT_ID})に触れる必要があります`,
          ['journalEntries', ei, 'metadata', 'reserveId'],
        );
    });

    // 月額化コスト(monthlyCostItems)の参照整合性。
    const monthlyCostIds = new Set<string>();
    pkg.monthlyCostItems.forEach((mc, mi) => {
      const at = (...p: (string | number)[]) => ['monthlyCostItems', mi, ...p];
      if (monthlyCostIds.has(mc.id))
        issue(`月額化コストの ID が重複しています(${mc.id})`, at('id'));
      monthlyCostIds.add(mc.id);
      if (!hasScope(mc.managementScopeId))
        issue(`月額化「${mc.name}」の管理区分が存在しません`, at('managementScopeId'));

      // 費用カテゴリ: 存在 + role expense-category。
      if (!accountType.has(mc.expenseAccountId))
        issue(`月額化「${mc.name}」の expenseAccountId が存在しません`, at('expenseAccountId'));
      else if (accountRole.get(mc.expenseAccountId) !== 'expense-category')
        issue(
          `月額化「${mc.name}」の expenseAccountId は支出カテゴリである必要があります`,
          at('expenseAccountId'),
        );

      // 支払い元: 任意。あれば daily-asset または payment-liability。
      if (mc.paymentAccountId !== undefined) {
        const payRole = accountRole.get(mc.paymentAccountId);
        if (!accountType.has(mc.paymentAccountId))
          issue(`月額化「${mc.name}」の paymentAccountId が存在しません`, at('paymentAccountId'));
        else if (payRole !== 'daily-asset' && payRole !== 'payment-liability')
          issue(
            `月額化「${mc.name}」の paymentAccountId は日常資産または支払用負債である必要があります`,
            at('paymentAccountId'),
          );
      }

      // 資産経由モデルの支払い元(資産化の貸方): 任意。あれば daily-asset または payment-liability。
      if (mc.paymentSourceAccountId !== undefined) {
        const srcRole = accountRole.get(mc.paymentSourceAccountId);
        if (!accountType.has(mc.paymentSourceAccountId))
          issue(
            `継続コスト「${mc.name}」の paymentSourceAccountId が存在しません`,
            at('paymentSourceAccountId'),
          );
        else if (
          srcRole !== 'daily-asset' &&
          srcRole !== 'payment-liability' &&
          srcRole !== 'other-liability'
        )
          issue(
            `継続コスト「${mc.name}」の paymentSourceAccountId は日常資産・支払用負債・その他負債のいずれかである必要があります`,
            at('paymentSourceAccountId'),
          );
      }

      // 認識の貸方科目: 任意。あれば継続コスト対象資産(continuing-cost-asset)か固定資産(fixed-asset)。
      if (mc.recognitionCreditAccountId !== undefined) {
        const recRole = accountRole.get(mc.recognitionCreditAccountId);
        if (!accountType.has(mc.recognitionCreditAccountId))
          issue(
            `継続コスト「${mc.name}」の recognitionCreditAccountId が存在しません`,
            at('recognitionCreditAccountId'),
          );
        else if (recRole !== 'continuing-cost-asset' && recRole !== 'fixed-asset')
          issue(
            `継続コスト「${mc.name}」の recognitionCreditAccountId は継続コスト対象資産または固定資産である必要があります`,
            at('recognitionCreditAccountId'),
          );
      }

      // 返済口座: 任意。あれば daily-asset。
      if (mc.repaymentAccountId !== undefined) {
        if (!accountType.has(mc.repaymentAccountId))
          issue(
            `月額化「${mc.name}」の repaymentAccountId が存在しません`,
            at('repaymentAccountId'),
          );
        else if (accountRole.get(mc.repaymentAccountId) !== 'daily-asset')
          issue(
            `月額化「${mc.name}」の repaymentAccountId は日常資産である必要があります`,
            at('repaymentAccountId'),
          );
      }

      // 周期は costMonths 以上（束が重ならない）。
      if (mc.repeatEveryMonths !== undefined && mc.repeatEveryMonths < mc.costMonths)
        issue(
          `月額化「${mc.name}」の repeatEveryMonths は costMonths 以上である必要があります`,
          at('repeatEveryMonths'),
        );

      // 既存按分との紐づけがあれば、その allocation が存在する。
      if (mc.sourceAllocationId !== undefined && !allocationIds.has(mc.sourceAllocationId))
        issue(`月額化「${mc.name}」の sourceAllocationId が存在しません`, at('sourceAllocationId'));

      // 仮想認識の貸方科目（固定資産など）があれば、その科目が存在する。
      if (
        mc.recognitionCreditAccountId !== undefined &&
        !accountType.has(mc.recognitionCreditAccountId)
      )
        issue(
          `月額化「${mc.name}」の recognitionCreditAccountId が存在しません`,
          at('recognitionCreditAccountId'),
        );
    });

    // 固定資産処分(assetDisposals)の参照整合性。
    const journalEntryIds = new Set(pkg.journalEntries.map((e) => e.id));
    const disposalIds = new Set<string>();
    pkg.assetDisposals.forEach((d, di) => {
      const at = (...p: (string | number)[]) => ['assetDisposals', di, ...p];
      if (disposalIds.has(d.id)) issue(`固定資産処分の ID が重複しています(${d.id})`, at('id'));
      disposalIds.add(d.id);
      if (!hasScope(d.managementScopeId))
        issue(`固定資産処分の管理区分が存在しません`, at('managementScopeId'));
      if (!monthlyCostIdSet.has(d.monthlyCostId))
        issue(`固定資産処分の monthlyCostId が存在しません`, at('monthlyCostId'));
      // 処分対象は継続コスト資産（fixed-asset、または継続コスト台帳口座=continuing-cost-asset。
      // 後者はサブスク解約等の「0円で売却」を含む継続コストの売却終了で使う）。
      if (!accountType.has(d.fixedAccountId))
        issue(`固定資産処分の fixedAccountId が存在しません`, at('fixedAccountId'));
      else {
        const fixedRole = accountRole.get(d.fixedAccountId);
        if (fixedRole !== 'fixed-asset' && fixedRole !== 'continuing-cost-asset')
          issue(
            `処分の fixedAccountId は固定資産または継続コスト台帳の科目である必要があります`,
            at('fixedAccountId'),
          );
      }
      // 入金先は任意。あれば daily-asset または reserve-asset。
      if (d.destinationAccountId !== undefined) {
        const role = accountRole.get(d.destinationAccountId);
        if (!accountType.has(d.destinationAccountId))
          issue(`固定資産処分の destinationAccountId が存在しません`, at('destinationAccountId'));
        else if (role !== 'daily-asset' && role !== 'reserve-asset')
          issue(
            `固定資産処分の入金先は日常資産または目的別資金である必要があります`,
            at('destinationAccountId'),
          );
      }
      // 売却額があれば入金先必須。
      if (d.proceedsAmount > 0 && d.destinationAccountId === undefined)
        issue(`売却額があるのに入金先がありません`, at('destinationAccountId'));
      // 残存額は amount との整合（recognized + remaining の不変条件は repository が保証）。
      // 生成仕訳 ID は実在すること。
      d.generatedEntryIds.forEach((eid, gi) => {
        if (!journalEntryIds.has(eid))
          issue(
            `固定資産処分の generatedEntryIds が存在しません(${eid})`,
            at('generatedEntryIds', gi),
          );
      });
    });

    // タグ(tags): id 一意 + active な同名重複なし。タグは「仕訳全体のみ」（明細タグは廃止）。
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
    pkg.cashflowSchedules.forEach((s, si) => {
      checkTags(s.entryTagIds, ['cashflowSchedules', si, 'entryTagIds']);
    });
  });

export type LedgerExportPackageInput = z.infer<typeof ledgerExportPackageSchema>;

/** 現行版のエクスポートか（migration 不要か）。 */
export function isCurrentSchema(version: number): boolean {
  return version === SCHEMA_VERSION;
}
