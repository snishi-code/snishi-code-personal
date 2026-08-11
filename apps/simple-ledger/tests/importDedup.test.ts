import { describe, expect, it } from 'vitest';
import './setup';
import type { JournalEntry } from '../src/domain/types';
import { externalRowKey, fingerprintRowKey } from '../src/domain/importIdentity';
import {
  resolveImportRows,
  type DedupRow,
  type ImportDecisionSummary,
} from '../src/domain/importDedup';

function entry(id: string, date: string, amount: number, accountId = 'paypay'): JournalEntry {
  return {
    id,
    date,
    description: id,
    kind: 'normal',
    lines: [
      { accountId: 'food', side: 'debit', amount },
      { accountId, side: 'credit', amount },
    ],
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function dedupRow(rowKey: string, overrides: Partial<DedupRow> = {}): DedupRow {
  return { rowKey, date: '2026-08-01', amount: 100, ownSide: 'credit', ...overrides };
}

const SRC = 'PayPay本体';

describe('resolveImportRows（層1: rowKey 決定的照合）', () => {
  it('registered 決定 + 実在仕訳 = decided', () => {
    const key = externalRowKey(SRC, ['id-1', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'registered', entryId: 'e1' }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('decided');
    expect(r[0]!.decision?.entryId).toBe('e1');
  });

  it('ignored 決定 = decided（entryId 不要）', () => {
    const key = externalRowKey(SRC, ['id-2', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([[key, { status: 'ignored' }]]);
    const r = resolveImportRows({ rows: [dedupRow(key)], decisions, existingEntries: [] });
    expect(r[0]!.status).toBe('decided');
  });

  it('決定なし = unresolved', () => {
    const key = externalRowKey(SRC, ['id-3', '支払い']);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions: new Map(),
      existingEntries: [],
    });
    expect(r[0]!.status).toBe('unresolved');
  });

  it('決定はあるが仕訳が実在しない = unresolved-dangling（黙って skip しない）', () => {
    const key = externalRowKey(SRC, ['id-4', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'linked', entryId: 'gone' }],
    ]);
    const r = resolveImportRows({ rows: [dedupRow(key)], decisions, existingEntries: [] });
    expect(r[0]!.status).toBe('unresolved-dangling');
    expect(r[0]!.decision?.status).toBe('linked');
  });

  it('決定的照合は date / amount に依存しない（rowKey だけで決まる）', () => {
    const key = externalRowKey(SRC, ['id-5', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'registered', entryId: 'e1' }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(key, { date: '2030-01-01', amount: 99999 })],
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
    });
    expect(r[0]!.status).toBe('decided');
  });
});

describe('resolveImportRows（fp キーの同一ファイル規則・作者決定 2026-08-11・P1-1）', () => {
  const fp = 'aa'.repeat(32);
  const FILE_A = 'file-hash-a';
  const FILE_B = 'file-hash-b';

  it('同一ファイルの再取込（決定の fileHash = レビュー中の fileHash）= 黙って decided', () => {
    const rows = [dedupRow(fingerprintRowKey(SRC, fp, 1)), dedupRow(fingerprintRowKey(SRC, fp, 2))];
    const decisions = new Map<string, ImportDecisionSummary>([
      [fingerprintRowKey(SRC, fp, 1), { status: 'registered', entryId: 'e1', fileHash: FILE_A }],
      [fingerprintRowKey(SRC, fp, 2), { status: 'ignored', fileHash: FILE_A }],
    ]);
    const r = resolveImportRows({
      rows,
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
      fileHash: FILE_A,
    });
    expect(r.map((x) => x.status)).toEqual(['decided', 'decided']);
  });

  it('部分適用の残り（同一ファイル）: 決定済み occurrence は decided・残りは普通の未解決', () => {
    // 同一生行 3 件のうち occurrence 1 だけ適用済み → 1 は decided / 2, 3 は unresolved。
    // 旧仕様はここを count-mismatch にして決定を削除させていた（P1 バグの根）。
    const decisions = new Map<string, ImportDecisionSummary>([
      [fingerprintRowKey(SRC, fp, 1), { status: 'registered', entryId: 'e1', fileHash: FILE_A }],
    ]);
    const rows = [
      dedupRow(fingerprintRowKey(SRC, fp, 1)),
      dedupRow(fingerprintRowKey(SRC, fp, 2)),
      dedupRow(fingerprintRowKey(SRC, fp, 3)),
    ];
    const r = resolveImportRows({
      rows,
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
      fileHash: FILE_A,
    });
    expect(r.map((x) => x.status)).toEqual(['decided', 'unresolved', 'unresolved']);
  });

  it('別ファイルの同 fingerprint ヒット = unresolved-prior-decision（黙ってスキップしない）', () => {
    // 部分エクスポート間の occurrence ずれで別の行が同じキーを名乗り得るため、
    // アプリ側で決定せずレビューへ出す（既定の提案 = スキップ・確定はユーザー）。
    const decisions = new Map<string, ImportDecisionSummary>([
      [fingerprintRowKey(SRC, fp, 1), { status: 'registered', entryId: 'e1', fileHash: FILE_A }],
      [fingerprintRowKey(SRC, fp, 2), { status: 'ignored', fileHash: FILE_A }],
    ]);
    const rows = [dedupRow(fingerprintRowKey(SRC, fp, 1)), dedupRow(fingerprintRowKey(SRC, fp, 2))];
    const r = resolveImportRows({
      rows,
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
      fileHash: FILE_B,
    });
    expect(r.map((x) => x.status)).toEqual([
      'unresolved-prior-decision',
      'unresolved-prior-decision',
    ]);
    // ヒットした決定は提示用に添付される（この層は読み取り専用 = 削除を指示しない）。
    expect(r[0]!.decision).toEqual({ status: 'registered', entryId: 'e1', fileHash: FILE_A });
    expect(r[1]!.decision).toEqual({ status: 'ignored', fileHash: FILE_A });
  });

  it('fileHash が欠けている（決定側 / レビュー側）は同一性を確認できない = fail-closed にレビューへ', () => {
    const key = fingerprintRowKey(SRC, fp, 1);
    // 決定側に fileHash 無し。
    const withoutDecisionHash = resolveImportRows({
      rows: [dedupRow(key)],
      decisions: new Map<string, ImportDecisionSummary>([[key, { status: 'ignored' }]]),
      existingEntries: [],
      fileHash: FILE_A,
    });
    expect(withoutDecisionHash[0]!.status).toBe('unresolved-prior-decision');
    // レビュー側（input.fileHash）無し。
    const withoutInputHash = resolveImportRows({
      rows: [dedupRow(key)],
      decisions: new Map<string, ImportDecisionSummary>([
        [key, { status: 'ignored', fileHash: FILE_A }],
      ]),
      existingEntries: [],
    });
    expect(withoutInputHash[0]!.status).toBe('unresolved-prior-decision');
  });

  it('externalId 型キーは別ファイルでも従来どおり decided（不変）', () => {
    const key = externalRowKey(SRC, ['id-ext-1', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'registered', entryId: 'e1', fileHash: FILE_A }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
      fileHash: FILE_B,
    });
    expect(r[0]!.status).toBe('decided');
  });

  it('dangling（参照先仕訳なし）は同一ファイル規則より優先してレビューへ出る', () => {
    const key = fingerprintRowKey(SRC, fp, 1);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'registered', entryId: 'gone', fileHash: FILE_A }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions,
      existingEntries: [],
      fileHash: FILE_A,
    });
    expect(r[0]!.status).toBe('unresolved-dangling');
  });

  it('sourceId が違えば同じ fingerprint でも別名前空間（照合されない)', () => {
    const decisions = new Map<string, ImportDecisionSummary>([
      [fingerprintRowKey('別の口座', fp, 1), { status: 'ignored', fileHash: FILE_A }],
      [fingerprintRowKey('別の口座', fp, 2), { status: 'ignored', fileHash: FILE_A }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(fingerprintRowKey(SRC, fp, 1))],
      decisions,
      existingEntries: [],
      fileHash: FILE_A,
    });
    expect(r[0]!.status).toBe('unresolved');
  });
});

describe('resolveImportRows（層2: 類似候補は提示のみ）', () => {
  it('日付±N日・同額・自口座一致の既存仕訳を候補として返す（status は変えない）', () => {
    const key = externalRowKey(SRC, ['id-9', '支払い']);
    const near = entry('near', '2026-08-02', 100);
    const far = entry('far', '2026-08-20', 100);
    const otherAmount = entry('other-amount', '2026-08-01', 999);
    const otherAccount = entry('other-account', '2026-08-01', 100, 'cash');
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions: new Map(),
      existingEntries: [far, near, otherAmount, otherAccount],
      ownAccountId: 'paypay',
    });
    expect(r[0]!.status).toBe('unresolved');
    expect(r[0]!.similarEntryIds).toEqual(['near']);
  });

  it('ownAccountId が無ければ候補は出さない（自口座一致を満たせない）', () => {
    const key = externalRowKey(SRC, ['id-10', '支払い']);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions: new Map(),
      existingEntries: [entry('near', '2026-08-01', 100)],
    });
    expect(r[0]!.similarEntryIds).toEqual([]);
  });

  it('自口座の side が一致しない仕訳は候補にしない', () => {
    const key = externalRowKey(SRC, ['id-11', '支払い']);
    const r = resolveImportRows({
      rows: [dedupRow(key, { ownSide: 'debit' })],
      decisions: new Map(),
      existingEntries: [entry('credit-side', '2026-08-01', 100)],
      ownAccountId: 'paypay',
    });
    expect(r[0]!.similarEntryIds).toEqual([]);
  });

  it('decided の行には候補を出さない（レビュー対象でない）', () => {
    const key = externalRowKey(SRC, ['id-12', '支払い']);
    const decisions = new Map<string, ImportDecisionSummary>([
      [key, { status: 'registered', entryId: 'e1' }],
    ]);
    const r = resolveImportRows({
      rows: [dedupRow(key)],
      decisions,
      existingEntries: [entry('e1', '2026-08-01', 100)],
      ownAccountId: 'paypay',
    });
    expect(r[0]!.similarEntryIds).toEqual([]);
  });

  // 索引化（項目8: 行ごとの全仕訳走査の除去）で判定・順序が変わらないことの固定。
  it('候補の順序は 日付距離 → 日付 → 仕訳の並び順（索引化後も同一）', () => {
    const mk = (id: string, date: string): JournalEntry => entry(id, date, 100);
    const r = resolveImportRows({
      rows: [dedupRow(externalRowKey(SRC, ['id-14', '支払い']), { date: '2026-08-10' })],
      decisions: new Map(),
      // 距離 2（08-08 / 08-12）・距離 1（08-09）・距離 0（08-10 が 2 件 = 入力順）を混在。
      existingEntries: [
        mk('d2-before', '2026-08-08'),
        mk('d0-first', '2026-08-10'),
        mk('d1', '2026-08-09'),
        mk('d0-second', '2026-08-10'),
        mk('d2-after', '2026-08-12'),
      ],
      ownAccountId: 'paypay',
    });
    expect(r[0]!.similarEntryIds).toEqual(['d0-first', 'd0-second', 'd1', 'd2-before', 'd2-after']);
  });

  it('同一仕訳内に同型の行が複数あっても候補は 1 回・別金額の行は別々に候補になる', () => {
    // 自口座 credit 100 の行を 2 本 + credit 200 の行を持つ仕訳。
    const multi: JournalEntry = {
      id: 'multi',
      date: '2026-08-01',
      description: 'multi',
      kind: 'normal',
      lines: [
        { accountId: 'food', side: 'debit', amount: 400 },
        { accountId: 'paypay', side: 'credit', amount: 100 },
        { accountId: 'paypay', side: 'credit', amount: 200 },
        { accountId: 'paypay', side: 'credit', amount: 100 },
      ],
      createdAt: 'x',
      updatedAt: 'x',
    };
    const input = { decisions: new Map<string, ImportDecisionSummary>(), ownAccountId: 'paypay' };
    const r100 = resolveImportRows({
      ...input,
      rows: [dedupRow(externalRowKey(SRC, ['id-15', '支払い']), { amount: 100 })],
      existingEntries: [multi],
    });
    expect(r100[0]!.similarEntryIds).toEqual(['multi']);
    const r200 = resolveImportRows({
      ...input,
      rows: [dedupRow(externalRowKey(SRC, ['id-16', '支払い']), { amount: 200 })],
      existingEntries: [multi],
    });
    expect(r200[0]!.similarEntryIds).toEqual(['multi']);
  });

  it('候補は上限（SIMILAR_CANDIDATE_LIMIT）件まで', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`e${i}`, '2026-08-01', 100));
    const r = resolveImportRows({
      rows: [dedupRow(externalRowKey(SRC, ['id-17', '支払い']))],
      decisions: new Map(),
      existingEntries: entries,
      ownAccountId: 'paypay',
    });
    expect(r[0]!.similarEntryIds).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });
});

describe('resolveImportRows（groupId 不参加）', () => {
  it('groupId が付いた行でも判定・候補が変わらない', () => {
    const key = externalRowKey(SRC, ['id-13', '支払い']);
    const base = dedupRow(key);
    const withGroup = { ...base, groupId: 'g1' } as DedupRow;
    const input = {
      decisions: new Map<string, ImportDecisionSummary>(),
      existingEntries: [entry('near', '2026-08-01', 100)],
      ownAccountId: 'paypay',
    };
    const a = resolveImportRows({ ...input, rows: [base] });
    const b = resolveImportRows({ ...input, rows: [withGroup] });
    expect(b).toEqual(a);
  });
});
