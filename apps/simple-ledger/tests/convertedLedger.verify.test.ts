/*
 * **実 converter の出力を、アプリ本体の v11 schema と import パイプラインで検証する。**
 *
 * Codex 統合監査の指摘:
 *  - converter の入力検証は簡易で、変換後もアプリの schema を通していない
 *    → converter が成功しても import が落ちる組み合わせがあり、
 *      現手順では「DB を初期化したあと」に初めて失敗が判明しうる
 *  - dbUpgrade の移行テストは converter の出力ではなく手書きオブジェクトを使っていた
 *
 * 対策はスキーマの複製ではなく**実物どうしを突き合わせる**こと:
 *  1) 合成 v10 fixture を実 converter（.mjs）へ通し、出力を実 schema + 実 import で検証する（常時実行）
 *  2) 作者の実データも、DB を初期化する前に同じ経路で検証できるようにする（env var で任意実行）
 *     CONVERTED_LEDGER_JSON=<変換済み.json> npx vitest run tests/convertedLedger.verify.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import './setup';
import { SCHEMA_VERSION } from '../src/data/constants';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { importFromJsonText } from '../src/data/exportImport';
import { loadLedger } from '../src/data/repository';

/**
 * converter はリポジトリ外（_workspace-management/scripts）にある。
 * worktree からでも main repo からでも見つかるよう、cwd から上へ探索する。
 * 見つからない環境（CI で workspace-management を持たない等）では skip する。
 */
function findConverter(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(
      dir,
      '_workspace-management',
      'scripts',
      'convert-ledger-v10-to-v11.mjs',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const CONVERTER = findConverter();

/** v10 の交換パッケージ（実 converter の入力形）。金額は「単位」そのままの整数。 */
function v10Package() {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    appId: 'snishi-code.simple-ledger-v2',
    schemaVersion: 10,
    ledgerId: 'ledger',
    exportedAt: '2026-08-13T00:00:00.000Z',
    deviceId: 'dev',
    revision: 5,
    accounts: [
      {
        id: 'cash',
        name: '現金',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'food',
        name: '食費',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'adj-exp',
        name: '残高調整費',
        type: 'expense',
        role: 'system-adjustment',
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'equity',
        name: '初期残高',
        type: 'equity',
        role: 'equity',
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    journalEntries: [
      {
        id: 'opening',
        date: '2026-01-01',
        description: '初期残高（現金）',
        kind: 'opening',
        lines: [
          { accountId: 'cash', side: 'debit', amount: 10000 },
          { accountId: 'equity', side: 'credit', amount: 10000 },
        ],
        metadata: { inputMode: 'manual' },
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: 'expense',
        date: '2026-01-05',
        description: '昼食',
        kind: 'normal',
        lines: [
          { accountId: 'food', side: 'debit', amount: 1200 },
          { accountId: 'cash', side: 'credit', amount: 1200 },
        ],
        metadata: { inputMode: 'expense' },
        createdAt: ts,
        updatedAt: ts,
      },
      {
        // 補正（metadata の 3 値も ×100 対象。ただし集計残高なので 1 仕訳の上限は当てない）。
        id: 'adjust',
        date: '2026-01-31',
        description: '残高補正: 現金',
        kind: 'normal',
        lines: [
          { accountId: 'adj-exp', side: 'debit', amount: 300 },
          { accountId: 'cash', side: 'credit', amount: 300 },
        ],
        metadata: {
          inputMode: 'manual',
          adjustment: {
            accountId: 'cash',
            expectedBalance: 8800,
            actualBalance: 8500,
            delta: -300,
            counterpartAccountId: 'adj-exp',
          },
        },
        createdAt: ts,
        updatedAt: ts,
      },
    ],
    tags: [],
    monthlyCostItems: [],
    recurringRules: [],
    settings: { ledgerName: '家計簿', currency: 'JPY', locale: 'ja' },
  };
}

function runConverter(pkg: unknown, extraArgs: string[] = []): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-convert-'));
  const src = join(dir, 'v10.json');
  const dst = join(dir, 'v11.json');
  writeFileSync(src, JSON.stringify(pkg));
  execFileSync('node', [CONVERTER!, src, dst, ...extraArgs], { encoding: 'utf8' });
  return JSON.parse(readFileSync(dst, 'utf8')) as Record<string, unknown>;
}

describe.skipIf(!CONVERTER)('実 converter の出力をアプリ本体の schema / import で検証する', () => {
  it('合成 v10 → converter → 実 schema 検証 → 実 import が通り、金額が ×100 されている', async () => {
    const converted = runConverter(v10Package(), ['--currency=円']);

    // 1) アプリ本体の v11 schema（converter の複製ではなく実物）で検証する。
    const parsed = ledgerExportPackageSchema.safeParse(converted);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    expect(converted['schemaVersion']).toBe(SCHEMA_VERSION);

    // 2) 実 import パイプライン（7 段階 fail-closed）を通す。
    const outcome = await importFromJsonText(JSON.stringify(converted), { force: true });
    expect(outcome.kind).toBe('ok');

    // 3) 取り込まれた値が minor になっている。
    const ledger = await loadLedger();
    expect(ledger.journalEntries.find((e) => e.id === 'expense')?.lines[0]?.amount).toBe(120000);
    expect(ledger.journalEntries.find((e) => e.id === 'opening')?.lines[0]?.amount).toBe(1000000);
    const adj = ledger.journalEntries.find((e) => e.id === 'adjust')?.metadata?.adjustment;
    expect(adj?.expectedBalance).toBe(880000);
    expect(adj?.actualBalance).toBe(850000);
    expect(adj?.delta).toBe(-30000);
    expect(ledger.settings.currency).toBe('円');
    expect(ledger.settings.displayFractionDigits).toBe(0);
    expect('locale' in ledger.settings).toBe(false);
  });

  it('converter が見ない不整合も、変換後に実 schema を通すことで import 前に気付ける', async () => {
    // converter は「×100 と settings の 3 点」しか見ない。貸借の一致などは見ないので、
    // 手編集された入力はここをすり抜ける。**変換後に実 schema を通す**この経路が最後の砦。
    const pkg = v10Package();
    pkg.journalEntries[1]!.lines[1]!.amount = 900; // 借方 1200 / 貸方 900（貸借不一致）
    const converted = runConverter(pkg);
    const parsed = ledgerExportPackageSchema.safeParse(converted);
    expect(parsed.success).toBe(false);
    // DB を初期化する前にここで気付ける、が本テストの主眼。
    const outcome = await importFromJsonText(JSON.stringify(converted));
    expect(outcome.kind).toBe('validation-error');
  });

  it('converter 自身も、単位の長さ・未知オプション・非オブジェクト要素を fail-closed で弾く', () => {
    // 単位は「通貨リスト」ではなく長さだけ（schema の min(1).max(8) と同じ境界）を見る。
    expect(() => runConverter(v10Package(), ['--currency=123456789'])).toThrow();
    expect(() => runConverter(v10Package(), ['--currency=12345678'])).not.toThrow();
    // タイプミスを黙って無視しない。
    expect(() => runConverter(v10Package(), ['--currncy=円'])).toThrow();
    // 素の TypeError ではなく 'NG: …' で止まる。
    const broken = v10Package();
    (broken.journalEntries as unknown[])[0] = null;
    expect(() => runConverter(broken)).toThrow();
  });

  it('補正 metadata の残高には 1 仕訳の上限を当てない（合法な大残高の台帳が変換できる）', () => {
    const pkg = v10Package();
    const adj = pkg.journalEntries[2]!.metadata!.adjustment!;
    // 1 仕訳の上限（10^12 minor = 100 億単位）を超える「残高」。仕訳の金額ではない。
    adj.expectedBalance = 20_000_000_000;
    adj.actualBalance = 20_000_000_000;
    adj.delta = 0;
    // delta === 0 は schema が別途拒否するため、ここでは converter が落ちないことだけを見る。
    const converted = runConverter(pkg);
    const out = (
      converted['journalEntries'] as {
        id: string;
        metadata?: { adjustment?: Record<string, number> };
      }[]
    ).find((e) => e.id === 'adjust')!;
    expect(out.metadata?.adjustment?.['expectedBalance']).toBe(2_000_000_000_000);
  });
});

/**
 * 作者の実データ検証（DB 初期化の前に走らせる）。
 * CONVERTED_LEDGER_JSON が無いときは skip する。
 */
const targetPath = process.env['CONVERTED_LEDGER_JSON'];
describe.skipIf(!targetPath)('変換済みの実データを検証する', () => {
  it('実 schema と import パイプラインを通る', async () => {
    const text = readFileSync(targetPath!, 'utf8');
    const parsed = ledgerExportPackageSchema.safeParse(JSON.parse(text));
    expect(
      parsed.success,
      `schema 検証に失敗: ${JSON.stringify(parsed.error?.issues?.slice(0, 5))}`,
    ).toBe(true);
    const outcome = await importFromJsonText(text, { force: true });
    expect(outcome.kind, `import に失敗: ${JSON.stringify(outcome)}`).toBe('ok');
    const ledger = await loadLedger();
    // 件数だけ出して、作者が実データの規模を目視確認できるようにする。
    console.log(
      `検証OK: 科目 ${ledger.accounts.length} / 仕訳 ${ledger.journalEntries.length} / ` +
        `継続コスト ${ledger.monthlyCostItems.length} / ルール ${ledger.recurringRules.length}`,
    );
  });
});
