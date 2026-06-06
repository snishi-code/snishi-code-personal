/*
 * Zod スキーマ。import 時の境界検証はすべてここを通す。
 * 型は src/domain/types.ts と一致させる（z.infer で照合可能）。
 */
import { z } from 'zod';
import { APP_ID, SCHEMA_VERSION } from './constants';

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

export const journalEntrySchema = z
  .object({
    id: z.string().min(1),
    date: isoDate,
    description: z.string().min(1).max(200),
    lines: z.array(journalLineSchema).min(2),
    memo: z.string().max(1000).optional(),
    kind: z.enum(['normal', 'opening']),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((entry, ctx) => {
    const debit = entry.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const credit = entry.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
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
    settings: settingsSchema,
  })
  .superRefine((pkg, ctx) => {
    // 勘定科目 ID は一意であること。
    const seen = new Set<string>();
    pkg.accounts.forEach((a, i) => {
      if (seen.has(a.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `勘定科目 ID が重複しています(${a.id})`,
          path: ['accounts', i, 'id'],
        });
      }
      seen.add(a.id);
    });

    // 参照整合性: すべての仕訳明細の accountId が accounts に存在すること。
    // これを通さないと、存在しない科目を参照する仕訳が PL/BS から消えてしまう。
    pkg.journalEntries.forEach((e, ei) => {
      e.lines.forEach((l, li) => {
        if (!seen.has(l.accountId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `仕訳「${e.description}」が存在しない勘定科目(${l.accountId})を参照しています`,
            path: ['journalEntries', ei, 'lines', li, 'accountId'],
          });
        }
      });
    });
  });

export type LedgerExportPackageInput = z.infer<typeof ledgerExportPackageSchema>;

/** 現行版のエクスポートか（migration 不要か）。 */
export function isCurrentSchema(version: number): boolean {
  return version === SCHEMA_VERSION;
}
