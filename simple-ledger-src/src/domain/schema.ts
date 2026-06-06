/*
 * Zod スキーマ。import 時の境界検証はすべてここを通す。
 * 型は src/domain/types.ts と一致させる（z.infer で照合可能）。
 */
import { z } from 'zod';
import { APP_ID, SCHEMA_VERSION } from './constants';
import { addMonths, monthlyAmounts } from './allocation';

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

export const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  type: accountTypeSchema,
  archived: z.boolean(),
  note: z.string().max(500).optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const journalLineSchema = z.object({
  accountId: z.string().min(1),
  side: sideSchema,
  amount: amountSchema,
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

export const entryMetadataSchema = z.object({
  inputMode: inputModeSchema.optional(),
  reversalOfEntryId: z.string().min(1).optional(),
  allocationPlan: allocationPlanSchema.optional(),
  allocationId: z.string().min(1).optional(),
  allocationRole: z.enum(['source', 'recognition']).optional(),
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

export const journalEntrySchema = z
  .object({
    id: z.string().min(1),
    date: isoDate,
    description: z.string().min(1).max(200),
    lines: z.array(journalLineSchema).min(2),
    memo: z.string().max(1000).optional(),
    kind: z.enum(['normal', 'opening']),
    metadata: entryMetadataSchema.optional(),
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
    baseRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    accounts: z.array(accountSchema),
    journalEntries: z.array(journalEntrySchema),
    allocations: z.array(allocationItemSchema),
    settings: settingsSchema,
  })
  .superRefine((pkg, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    // 勘定科目 ID は一意 + type マップ。
    const accountType = new Map<string, string>();
    pkg.accounts.forEach((a, i) => {
      if (accountType.has(a.id))
        issue(`勘定科目 ID が重複しています(${a.id})`, ['accounts', i, 'id']);
      accountType.set(a.id, a.type);
    });
    const hasAccount = (id: string) => accountType.has(id);

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

      // 科目の存在と type（expense=費用 / payment=資産か負債 / deferred=資産）。
      const expType = accountType.get(al.expenseAccountId);
      if (expType === undefined)
        issue(`按分「${al.name}」の expenseAccountId が存在しません`, at('expenseAccountId'));
      else if (expType !== 'expense')
        issue(
          `按分「${al.name}」の expenseAccountId は費用科目である必要があります`,
          at('expenseAccountId'),
        );

      const payType = accountType.get(al.paymentAccountId);
      if (payType === undefined)
        issue(`按分「${al.name}」の paymentAccountId が存在しません`, at('paymentAccountId'));
      else if (payType !== 'asset' && payType !== 'liability')
        issue(
          `按分「${al.name}」の paymentAccountId は資産または負債である必要があります`,
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

      // 認識仕訳の本数 = months、ID 重複なし。
      if (al.recognitionEntryIds.length !== al.months) {
        issue(
          `按分「${al.name}」の認識仕訳数(${al.recognitionEntryIds.length})が按分月数(${al.months})と一致しません`,
          at('recognitionEntryIds'),
        );
      }
      if (new Set(al.recognitionEntryIds).size !== al.recognitionEntryIds.length) {
        issue(`按分「${al.name}」の認識仕訳 ID が重複しています`, at('recognitionEntryIds'));
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

      // 月次認識仕訳: メタ・借方 expense / 貸方 deferred・金額列・日付列・合計が定義どおり。
      const amounts = monthlyAmounts(al.totalAmount, al.months);
      let sum = 0;
      let allRecognitionOk = al.recognitionEntryIds.length === al.months;
      al.recognitionEntryIds.forEach((rid, i) => {
        const re = entryById.get(rid);
        if (!re) {
          issue(`按分「${al.name}」の認識仕訳(${rid})が存在しません`, at('recognitionEntryIds', i));
          allRecognitionOk = false;
          return;
        }
        if (re.metadata?.allocationId !== al.id || re.metadata?.allocationRole !== 'recognition')
          issue(
            `按分「${al.name}」の認識仕訳のメタ情報が一致しません`,
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
            `按分「${al.name}」の認識仕訳の科目/金額/日付が定義と一致しません`,
            at('recognitionEntryIds', i),
          );
          allRecognitionOk = false;
        }
        if (d) sum += d.amount;
      });
      if (allRecognitionOk && sum !== al.totalAmount) {
        issue(
          `按分「${al.name}」の認識仕訳の合計(${sum})が総額(${al.totalAmount})と一致しません`,
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
  });

export type LedgerExportPackageInput = z.infer<typeof ledgerExportPackageSchema>;

/** 現行版のエクスポートか（migration 不要か）。 */
export function isCurrentSchema(version: number): boolean {
  return version === SCHEMA_VERSION;
}
