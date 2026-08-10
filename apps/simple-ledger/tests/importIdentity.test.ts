import { describe, expect, it } from 'vitest';
import './setup';
import type { EvaluatedImportRow } from '../src/domain/importDsl';
import {
  IMPORT_IDENTITY_VERSION,
  attachRowKeys,
  decodeCanonicalTuple,
  encodeCanonicalTuple,
  externalRowKey,
  fingerprintRowKey,
  parseRowKey,
  rowKeyForRow,
  sha256Hex,
} from '../src/domain/importIdentity';

function row(overrides: Partial<EvaluatedImportRow>): EvaluatedImportRow {
  return {
    rowIndex: 1,
    rawLine: '2026/08/01,100,-,支払い,店A',
    date: '2026-08-01',
    description: '支払い 店A',
    amount: 100,
    kind: '支払い',
    counterparty: '店A',
    ownSide: 'credit',
    ...overrides,
  };
}

describe('canonical tuple', () => {
  it("['a,b','c'] と ['a','b,c'] が衝突しない（単純連結禁止の理由）", () => {
    expect(encodeCanonicalTuple(['a,b', 'c'])).not.toBe(encodeCanonicalTuple(['a', 'b,c']));
  });

  it('encode → decode で往復する', () => {
    const parts = ['PayPay本体', 1, 'ext', '0504,"x"', '支払い'];
    expect(decodeCanonicalTuple(encodeCanonicalTuple(parts))).toEqual(parts);
  });

  it('配列でない・不正な JSON・不正な要素型は undefined', () => {
    expect(decodeCanonicalTuple('{}')).toBeUndefined();
    expect(decodeCanonicalTuple('broken')).toBeUndefined();
    expect(decodeCanonicalTuple('[null]')).toBeUndefined();
  });
});

describe('sha256Hex', () => {
  it('既知値と一致する（SHA-256("abc")）', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('rowKeyForRow', () => {
  it('externalId 定義があれば ext キー（sourceId で名前空間が切れる）', async () => {
    const r = row({ externalIdTuple: ['0504', '支払い'] });
    const key = await rowKeyForRow('source-a', r);
    expect(key).toBe(externalRowKey('source-a', ['0504', '支払い']));
    expect(decodeCanonicalTuple(key)).toEqual([
      'source-a',
      IMPORT_IDENTITY_VERSION,
      'ext',
      '0504',
      '支払い',
    ]);
    const other = await rowKeyForRow('source-b', r);
    expect(other).not.toBe(key);
  });

  it('externalId が無ければ fingerprint キー（生行のトリムのみ・SHA-256）', async () => {
    const r = row({ rawLine: '  2026/08/01,100,-,支払い,店A  ' });
    const key = await rowKeyForRow('銀行A', r, { occurrence: 2 });
    const expectedFp = await sha256Hex('2026/08/01,100,-,支払い,店A');
    expect(key).toBe(fingerprintRowKey('銀行A', expectedFp, 2));
  });
});

describe('parseRowKey', () => {
  it('ext / fp キーを構造へ戻す', () => {
    const ext = parseRowKey(externalRowKey('src', ['a', 'b']));
    expect(ext).toEqual({
      sourceId: 'src',
      identityVersion: 1,
      body: { type: 'ext', tuple: ['a', 'b'] },
    });
    const fp = parseRowKey(fingerprintRowKey('src', 'deadbeef', 3));
    expect(fp).toEqual({
      sourceId: 'src',
      identityVersion: 1,
      body: { type: 'fp', fingerprint: 'deadbeef', occurrence: 3 },
    });
  });

  it('自分の形式でないキーは undefined（occurrence 0 以下・種別不明など）', () => {
    expect(parseRowKey('not json')).toBeUndefined();
    expect(parseRowKey(JSON.stringify(['src', 1, 'unknown', 'x']))).toBeUndefined();
    expect(parseRowKey(JSON.stringify(['src', 1, 'fp', 'hash', 0]))).toBeUndefined();
    expect(parseRowKey(JSON.stringify(['src', 'v1', 'ext', 'x']))).toBeUndefined();
  });
});

describe('attachRowKeys（occurrence 採番）', () => {
  it('同一 fingerprint はファイル内出現順で 1 始まりの occurrence を振る', async () => {
    const dup1 = row({ rowIndex: 2, rawLine: 'same-line' });
    const dup2 = row({ rowIndex: 3, rawLine: 'same-line' });
    const solo = row({ rowIndex: 4, rawLine: 'other-line' });
    const { rows, fingerprintCounts } = await attachRowKeys([dup1, dup2, solo], '銀行A');
    const fp = await sha256Hex('same-line');
    expect(rows[0]!.rowKey).toBe(fingerprintRowKey('銀行A', fp, 1));
    expect(rows[1]!.rowKey).toBe(fingerprintRowKey('銀行A', fp, 2));
    expect(parseRowKey(rows[2]!.rowKey)?.body).toMatchObject({ type: 'fp', occurrence: 1 });
    expect(fingerprintCounts.get(fp)).toBe(2);
    // 行キーは全行で一意。
    expect(new Set(rows.map((r) => r.rowKey)).size).toBe(3);
  });

  it('externalId 行は ext キーになり fingerprintCounts に入らない', async () => {
    const r = row({ externalIdTuple: ['id-1', '支払い'] });
    const { rows, fingerprintCounts } = await attachRowKeys([r], 'PayPay本体');
    expect(parseRowKey(rows[0]!.rowKey)?.body.type).toBe('ext');
    expect(fingerprintCounts.size).toBe(0);
  });

  it('トリム差だけの生行は同じ fingerprint 系列として採番される', async () => {
    const a = row({ rawLine: 'x,y' });
    const b = row({ rawLine: '  x,y  ' });
    const { rows } = await attachRowKeys([a, b], 'src');
    expect(parseRowKey(rows[0]!.rowKey)?.body).toMatchObject({ occurrence: 1 });
    expect(parseRowKey(rows[1]!.rowKey)?.body).toMatchObject({ occurrence: 2 });
  });
});
