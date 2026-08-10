import { describe, expect, it } from 'vitest';
import './setup';
import { decodeCsvBytes, parseCsv } from '../src/domain/importCsv';
import {
  evaluateProfile,
  importProfileDslSchema,
  importProfileSchema,
} from '../src/domain/importDsl';
import { attachRowKeys, parseRowKey } from '../src/domain/importIdentity';
import {
  PAYPAY_DSL,
  PAYPAY_KINDS,
  PAYPAY_KIND_HINTS,
  paypayBuiltinProfile,
} from '../src/domain/importProfilePresets';

/*
 * 実 CSV を模した合成 fixture（実データの値は使わない）。
 * 実ファイルの構造: UTF-8 BOM・13 列固定・カンマ金額（quote 付き）・`-`=空・
 * `YYYY/MM/DD HH:MM:SS`・行種 8 種。同秒重複と同番号ペア（同じ取引番号で
 * 取引内容が違う 2 行）を含める。
 */
const HEADER =
  '取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号';

const ROWS = [
  // 支払い（カンマ金額・取引方法に quote 付きカンマ）。同秒重複ペアの 1 行目。
  '2026/08/10 08:04:52,"1,400",-,-,-,-,-,支払い,テスト洗車場,"PayPayポイント (386円), PayPay残高 (1,014円)",-,-,90000000000000000001',
  // 同秒重複（取引番号だけ違う）。
  '2026/08/10 08:04:52,"1,400",-,-,-,-,-,支払い,テスト洗車場,PayPay残高,-,-,90000000000000000002',
  // チャージ（入金・カンマ金額）。
  '2026/08/07 18:08:08,-,"30,000",-,-,-,-,チャージ,PayPay,テスト銀行 *****00,-,-,90000000000000000003',
  // 同番号ペア: 同じ取引番号 90000000000000000010 で支払いと獲得。
  '2026/08/03 22:48:37,"6,053",-,-,-,-,-,支払い,テストモール,PayPay残高,-,-,90000000000000000010',
  '2026/08/03 22:48:37,-,57,-,-,-,-,ポイント、残高の獲得,テストモール,PayPayポイント,-,-,90000000000000000010',
  // 取消（獲得の逆向き = 出金）。
  '2026/08/04 10:00:00,57,-,-,-,-,-,ポイント、残高の取消,テストモール,PayPayポイント,-,-,90000000000000000005',
  // 請求書払い。
  '2026/07/01 12:00:00,5000,-,-,-,-,-,請求書払い,テスト市水道局,PayPay残高,-,-,90000000000000000006',
  // 送金 3 種。
  '2026/08/09 12:48:50,"5,000",-,-,-,-,-,送った金額,テスト太郎,PayPay残高,-,-,90000000000000000007',
  '2026/08/08 09:00:00,-,3000,-,-,-,-,受け取った金額,テスト花子,PayPay残高,-,-,90000000000000000008',
  '2026/08/05 15:00:00,10000,-,-,-,-,-,口座送金,テスト銀行,PayPay残高,-,-,90000000000000000009',
];

/** UTF-8 BOM 付きバイト列（実ファイルと同じ形）を作る。 */
function fixtureBytes(): Uint8Array {
  const body = new TextEncoder().encode([HEADER, ...ROWS].join('\r\n') + '\r\n');
  const bytes = new Uint8Array(3 + body.length);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(body, 3);
  return bytes;
}

function evaluateFixture() {
  const text = decodeCsvBytes(fixtureBytes(), PAYPAY_DSL.fileFormat.encoding);
  const records = parseCsv(text, { delimiter: PAYPAY_DSL.fileFormat.delimiter });
  return evaluateProfile(PAYPAY_DSL, records);
}

describe('PayPay 同梱 profile', () => {
  it('DSL schema（未知キー拒否）と profile schema を通る', () => {
    expect(importProfileDslSchema.safeParse(PAYPAY_DSL).success).toBe(true);
    const profile = paypayBuiltinProfile('2026-08-11T00:00:00.000Z');
    const parsed = importProfileSchema.safeParse(profile);
    expect(parsed.success).toBe(true);
    expect(profile.builtin).toEqual({ builtinId: 'paypay-csv', builtinVersion: 1 });
  });

  it('行種→ヒント表は 8 行種を全てカバーする', () => {
    expect(Object.keys(PAYPAY_KIND_HINTS).sort()).toEqual([...PAYPAY_KINDS].sort());
  });

  it('合成 fixture の全行が error / skip なしで分類される（保存則）', () => {
    const r = evaluateFixture();
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.normalized).toHaveLength(ROWS.length);
    expect(r.totalRowCount).toBe(ROWS.length);
  });

  it('行種・金額・日付切り捨て・ownSide が §3 の表どおりになる', () => {
    const r = evaluateFixture();
    expect(r.normalized.map((n) => [n.kind, n.amount, n.date, n.ownSide])).toEqual([
      ['支払い', 1400, '2026-08-10', 'credit'],
      ['支払い', 1400, '2026-08-10', 'credit'],
      ['チャージ', 30000, '2026-08-07', 'debit'],
      ['支払い', 6053, '2026-08-03', 'credit'],
      ['ポイント、残高の獲得', 57, '2026-08-03', 'debit'],
      ['ポイント、残高の取消', 57, '2026-08-04', 'credit'],
      ['請求書払い', 5000, '2026-07-01', 'credit'],
      ['送った金額', 5000, '2026-08-09', 'credit'],
      ['受け取った金額', 3000, '2026-08-08', 'debit'],
      ['口座送金', 10000, '2026-08-05', 'credit'],
    ]);
    // 評価器の導出 ownSide がヒント表の期待値と一致する（§3 の表の写経ズレ防止）。
    for (const row of r.normalized) {
      const hint = PAYPAY_KIND_HINTS[row.kind as keyof typeof PAYPAY_KIND_HINTS];
      expect(row.ownSide, row.kind).toBe(hint.expectedOwnSide);
    }
  });

  it('摘要 = 取引内容 + 取引先・取引先はそのまま counterparty になる', () => {
    const r = evaluateFixture();
    expect(r.normalized[0]!.description).toBe('支払い テスト洗車場');
    expect(r.normalized[2]!.description).toBe('チャージ PayPay');
    expect(r.normalized[0]!.counterparty).toBe('テスト洗車場');
  });

  it('externalId = [取引番号, 取引内容] で全行一意（同番号ペア・同秒重複も衝突しない）', async () => {
    const r = evaluateFixture();
    expect(r.normalized.every((n) => n.externalIdTuple !== undefined)).toBe(true);
    expect(r.normalized[0]!.externalIdTuple).toEqual(['90000000000000000001', '支払い']);
    const { rows, fingerprintCounts } = await attachRowKeys(r.normalized, 'PayPay本体');
    expect(new Set(rows.map((x) => x.rowKey)).size).toBe(ROWS.length);
    expect(rows.every((x) => parseRowKey(x.rowKey)?.body.type === 'ext')).toBe(true);
    expect(fingerprintCounts.size).toBe(0);
  });
});
