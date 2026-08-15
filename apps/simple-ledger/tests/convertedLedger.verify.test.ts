/*
 * **実 converter（v11 → v12）の出力を、アプリ本体の v12 schema と import パイプラインで検証する。**
 *
 * Codex 統合監査の指摘:
 *  - converter の入力検証は簡易で、変換後もアプリの schema を通していない
 *    → converter が成功しても import が落ちる組み合わせがあり、
 *      現手順では「DB を初期化したあと」に初めて失敗が判明しうる
 *  - dbUpgrade の移行テストは converter の出力ではなく手書きオブジェクトを使っていた
 *
 * 対策はスキーマの複製ではなく**実物どうしを突き合わせる**こと:
 *  1) 合成 v11 fixture を実 converter（.mjs）へ通し、出力を実 schema + 実 import で検証する
 *     （converter を持つローカル環境で実行。repo 単体の CI では skip されうる）
 *  2) 作者の実データも、DB を初期化する前に同じ経路で検証できるようにする（env var で任意実行）
 *     CONVERTED_LEDGER_JSON=<変換済み.json> npx vitest run tests/convertedLedger.verify.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import './setup';
import { CONTINUOUS_COST_LEDGER_ACCOUNT_ID, SCHEMA_VERSION } from '../src/domain/constants';
import { ledgerExportPackageSchema } from '../src/domain/schema';
import { ruleItemEndDate } from '../src/domain/recurring';
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
      'convert-ledger-v11-to-v12.mjs',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const CONVERTER = findConverter();

/**
 * converter の sidecar が指す変換前の原本が今も存在し、記録 SHA-256 と一致することを検証。
 * 2 ファイルの公開は単一 FS トランザクションではないため、この最終ゲートが
 * 中断時の片方だけの成果物も fail-closed で止める。
 */
function verifySourceSidecar(outputPath: string): void {
  const sidecarPath = `${outputPath}.source.sha256`;
  if (!existsSync(sidecarPath)) throw new Error(`source.sha256 が見つかりません: ${sidecarPath}`);
  const sidecar = readFileSync(sidecarPath, 'utf8');
  const match = /^([a-f0-9]{64}) {2}(.+)\n$/.exec(sidecar);
  if (!match) throw new Error('source.sha256 の形式が不正です');
  const expectedHash = match[1]!;
  const sourcePath = match[2]!;
  if (!existsSync(sourcePath)) throw new Error(`変換前の原本が見つかりません: ${sourcePath}`);
  const actualHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  if (actualHash !== expectedHash) throw new Error('原本の SHA-256 が sidecar と一致しません');
}

const TS = '2026-01-01T00:00:00.000Z';
const RULE_ID = 'rule-ins';
const CCR_ITEM_ID = `ccr-${RULE_ID}-2026-08`;
/** v11 の「周期末の月末」式 endDate（起票 2026-08 / 12 か月周期 → 2027-07 の月末）。 */
const LEGACY_CCR_END_DATE = '2027-07-31';
/** v12 の「次回起票日と同日」（2026-08 + 12 か月・日 15 → 2027-08-15）。 */
const SAME_DAY_CCR_END_DATE = '2027-08-15';

/**
 * v11 の交換パッケージ（実 converter の入力形）。金額は minor 整数（v11 で導入済み）。
 * v11 → v12 で意味が変わる 2 点を必ず含める:
 *  - allocationStartDate を持つ item（撤去対象）
 *  - 由来ルールつきの `ccr-` item（endDate が「周期末の月末」式）
 * 変わらないものの代表として、通常 item・仕訳・タグも入れて「触っていない」ことを見る。
 */
function v11Package() {
  return {
    appId: 'snishi-code.simple-ledger-v2',
    schemaVersion: 11,
    ledgerId: 'ledger',
    exportedAt: '2026-08-15T00:00:00.000Z',
    deviceId: 'dev',
    revision: 5,
    accounts: [
      {
        id: 'cash',
        name: '現金',
        type: 'asset',
        role: 'daily-asset',
        archived: false,
        startDate: '2026-01-01',
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: 'fixed',
        name: '固定費',
        type: 'expense',
        role: 'expense-category',
        archived: false,
        startDate: '2026-01-01',
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: 'equity',
        name: '初期残高',
        type: 'equity',
        role: 'equity',
        archived: false,
        startDate: '2026-01-01',
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        name: '継続コスト台帳',
        type: 'asset',
        role: 'continuing-cost-asset',
        archived: false,
        startDate: '2026-01-01',
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    journalEntries: [
      {
        id: 'opening',
        date: '2026-01-01',
        description: '初期残高（現金）',
        kind: 'opening',
        lines: [
          { accountId: 'cash', side: 'debit', amount: 500000000 },
          { accountId: 'equity', side: 'credit', amount: 500000000 },
        ],
        metadata: { inputMode: 'manual' },
        createdAt: TS,
        updatedAt: TS,
      },
      {
        id: 'lunch',
        date: '2026-01-05',
        description: '昼食',
        kind: 'normal',
        lines: [
          { accountId: 'fixed', side: 'debit', amount: 120000 },
          { accountId: 'cash', side: 'credit', amount: 120000 },
        ],
        metadata: { inputMode: 'expense' },
        tagIds: ['tag-trip'],
        createdAt: TS,
        updatedAt: TS,
      },
      {
        // allocationStartDate 付き item の購入の仕訳。
        id: 'p-laptop',
        date: '2026-03-10',
        description: 'ノートPC',
        kind: 'normal',
        lines: [
          { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 12000000 },
          { accountId: 'cash', side: 'credit', amount: 12000000 },
        ],
        metadata: { inputMode: 'expense', monthlyCostId: 'mc-laptop' },
        createdAt: TS,
        updatedAt: TS,
      },
      {
        // 通常 item の購入の仕訳。
        id: 'p-desk',
        date: '2026-04-02',
        description: 'デスク',
        kind: 'normal',
        lines: [
          { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 4000000 },
          { accountId: 'cash', side: 'credit', amount: 4000000 },
        ],
        metadata: { inputMode: 'expense', monthlyCostId: 'mc-desk' },
        createdAt: TS,
        updatedAt: TS,
      },
      {
        // ルール由来 item の購入の仕訳（決定的 ID + 由来 metadata）。
        id: `rec-${RULE_ID}-2026-08`,
        date: '2026-08-15',
        description: '保険',
        kind: 'normal',
        lines: [
          { accountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID, side: 'debit', amount: 3600000 },
          { accountId: 'cash', side: 'credit', amount: 3600000 },
        ],
        metadata: {
          monthlyCostId: CCR_ITEM_ID,
          recurringRuleId: RULE_ID,
          recurringMonth: '2026-08',
        },
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    tags: [
      {
        id: 'tag-trip',
        name: '旅行',
        scope: 'entry',
        color: '#123456',
        archived: false,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    monthlyCostItems: [
      {
        // 撤去対象の allocationStartDate を持つ item。
        id: 'mc-laptop',
        name: 'ノートPC',
        amount: 12000000,
        startDate: '2026-03-10',
        endDate: '2029-03-31',
        allocationStartDate: '2026-04-01',
        expenseAccountId: 'fixed',
        createdAt: TS,
        updatedAt: TS,
      },
      {
        // 通常 item（触られないことの対照）。
        id: 'mc-desk',
        name: 'デスク',
        amount: 4000000,
        startDate: '2026-04-02',
        endDate: '2027-04-01',
        expenseAccountId: 'fixed',
        createdAt: TS,
        updatedAt: TS,
      },
      {
        // ルール由来 item。endDate は v11 の「周期末の月末」式。
        id: CCR_ITEM_ID,
        name: '保険',
        amount: 3600000,
        startDate: '2026-08-15',
        endDate: LEGACY_CCR_END_DATE,
        expenseAccountId: 'fixed',
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    recurringRules: [
      {
        id: RULE_ID,
        name: '保険',
        amount: 3600000,
        dayOfMonth: 15,
        everyMonths: 12,
        spreadExpenseAccountId: 'fixed',
        debitAccountId: CONTINUOUS_COST_LEDGER_ACCOUNT_ID,
        creditAccountId: 'cash',
        startMonth: '2026-08',
        startDate: '2026-08-01',
        postedThroughMonth: '2026-08',
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    settings: { ledgerName: '家計簿', currency: '円', displayFractionDigits: 0 },
  };
}

type ConvertedPackage = Record<string, unknown> & {
  monthlyCostItems: Record<string, unknown>[];
};

function runConverter(pkg: unknown, extraArgs: string[] = []): ConvertedPackage {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-convert-'));
  const src = join(dir, 'v11.json');
  const dst = join(dir, 'v12.json');
  writeFileSync(src, JSON.stringify(pkg));
  execFileSync('node', [CONVERTER!, src, dst, ...extraArgs], { encoding: 'utf8' });
  // 成功は JSON 単体でなく、原本ハッシュの sidecar と対になって初めて成立する。
  verifySourceSidecar(dst);
  return JSON.parse(readFileSync(dst, 'utf8')) as ConvertedPackage;
}

function itemOf(pkg: ConvertedPackage, id: string): Record<string, unknown> {
  return pkg.monthlyCostItems.find((item) => item['id'] === id)!;
}

describe.skipIf(!CONVERTER)('実 converter の出力をアプリ本体の schema / import で検証する', () => {
  it('合成 v11 → converter → 実 schema 検証 → 実 import が通り、v12 の 2 点だけが変わる', async () => {
    const source = v11Package();
    const converted = runConverter(source);

    // 1) アプリ本体の v12 schema（converter の複製ではなく実物）で検証する。
    const parsed = ledgerExportPackageSchema.safeParse(converted);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    expect(converted['schemaVersion']).toBe(SCHEMA_VERSION);
    expect(converted['schemaVersion']).toBe(12);

    // 2) allocationStartDate は「schema が strip した」ではなく、出力 JSON から消えている。
    for (const item of converted.monthlyCostItems) {
      expect(Object.keys(item)).not.toContain('allocationStartDate');
    }

    // 3) ルール由来 item の endDate = 次回起票日と同日（アプリ本体の正本と一致する）。
    expect(itemOf(converted, CCR_ITEM_ID)['endDate']).toBe(SAME_DAY_CCR_END_DATE);
    expect(itemOf(converted, CCR_ITEM_ID)['endDate']).toBe(ruleItemEndDate('2026-08', 12, 15));
    // 通常 item の endDate は触らない。
    expect(itemOf(converted, 'mc-desk')['endDate']).toBe('2027-04-01');
    expect(itemOf(converted, 'mc-laptop')['endDate']).toBe('2029-03-31');

    // 4) 意図した 2 点以外はバイト等価（仕訳金額・タグ・ルール・科目・設定）。
    for (const key of ['accounts', 'journalEntries', 'tags', 'recurringRules', 'settings']) {
      expect(JSON.stringify(converted[key])).toBe(
        JSON.stringify((source as Record<string, unknown>)[key]),
      );
    }
    // item も「allocationStartDate 削除 + ccr endDate 書き換え」を戻せば入力と一致する
    // （キー順までは復元できないので、キーで整列して値の同一性を見る）。
    const restored = converted.monthlyCostItems.map((item) => {
      if (item['id'] === CCR_ITEM_ID) return { ...item, endDate: LEGACY_CCR_END_DATE };
      if (item['id'] === 'mc-laptop') return { ...item, allocationStartDate: '2026-04-01' };
      return item;
    });
    const normalize = (items: unknown[]) =>
      JSON.stringify(
        items.map((i) => Object.entries(i as object).sort(([a], [b]) => (a < b ? -1 : 1))),
      );
    expect(normalize(restored)).toBe(normalize(source.monthlyCostItems));

    // 5) 実 import パイプライン（7 段階 fail-closed）を通り、値がそのまま入る。
    const outcome = await importFromJsonText(JSON.stringify(converted), { force: true });
    expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
    const ledger = await loadLedger();
    expect(ledger.journalEntries.find((e) => e.id === 'lunch')?.lines[0]?.amount).toBe(120000);
    expect(ledger.monthlyCostItems.find((m) => m.id === CCR_ITEM_ID)?.endDate).toBe(
      SAME_DAY_CCR_END_DATE,
    );
    expect(ledger.tags.map((t) => t.id)).toContain('tag-trip');
    expect(ledger.settings.currency).toBe('円');
  });

  it('converter が見ない不整合も、変換後に実 schema を通すことで import 前に気付ける', async () => {
    // converter は「版数・allocationStartDate・ccr endDate」しか見ない。貸借の一致などは
    // 見ないので、手編集された入力はここをすり抜ける。
    // **変換後に実 schema を通す**この経路が最後の砦。
    const pkg = v11Package();
    pkg.journalEntries[1]!.lines[1]!.amount = 90000; // 借方 120000 / 貸方 90000（貸借不一致）
    const converted = runConverter(pkg);
    const parsed = ledgerExportPackageSchema.safeParse(converted);
    expect(parsed.success).toBe(false);
    // DB を初期化する前にここで気付ける、が本テストの主眼。
    const outcome = await importFromJsonText(JSON.stringify(converted));
    expect(outcome.kind).toBe('validation-error');
  });

  it('converter 自身も、版違い・由来なし ccr・未知オプション・非オブジェクト要素を fail-closed で弾く', () => {
    // 版数は 11 だけを受ける（v12 を二度通す事故も止まる）。
    expect(() => runConverter({ ...v11Package(), schemaVersion: 12 })).toThrow();
    expect(() => runConverter({ ...v11Package(), appId: 'other' })).toThrow();
    // ccr item の由来ルールが無ければ endDate を計算できない = 黙って残さず止まる
    // （アプリ側 schema と同じ不変条件）。
    const orphan = v11Package();
    orphan.recurringRules = [];
    expect(() => runConverter(orphan)).toThrow();
    // このスクリプトにオプションは無い。タイプミスを黙って無視しない。
    expect(() => runConverter(v11Package(), ['--currency=円'])).toThrow();
    expect(() => runConverter(v11Package(), ['--force'])).toThrow();
    // 非オブジェクト要素は、触らない配列（仕訳）でも 'OK' を名乗らせず、
    // 触る配列（item）でも素の TypeError にせず、'NG: …' で揃えて止める。
    for (const key of ['journalEntries', 'monthlyCostItems'] as const) {
      const broken = v11Package();
      (broken[key] as unknown[])[0] = null;
      expect(() => runConverter(broken), key).toThrow();
    }
  });

  it('sidecar が既にあるときは上書きせず、JSON だけを残す部分成功にもならない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-convert-sidecar-'));
    const src = join(dir, 'v11.json');
    const dst = join(dir, 'v12.json');
    const sidecar = `${dst}.source.sha256`;
    writeFileSync(src, JSON.stringify(v11Package()));
    writeFileSync(sidecar, '既存の検証記録\n');

    expect(() => execFileSync('node', [CONVERTER!, src, dst], { encoding: 'utf8' })).toThrow();
    expect(existsSync(dst)).toBe(false);
    expect(readFileSync(sidecar, 'utf8')).toBe('既存の検証記録\n');
  });
});

/**
 * 作者の実データ検証（DB 初期化の前に走らせる）。
 * CONVERTED_LEDGER_JSON が無い通常 CI では意図的に skip する。この skip は移行確認の成功を
 * 意味しない。実機の DB を初期化する前に対象ファイルを明示して別途 green にする手動ゲート。
 */
const targetPath = process.env['CONVERTED_LEDGER_JSON'];
describe.skipIf(!targetPath)('実データ移行の手動ゲート（CONVERTED_LEDGER_JSON 必須）', () => {
  it('実 schema と import パイプラインを通る', async () => {
    verifySourceSidecar(targetPath!);
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
