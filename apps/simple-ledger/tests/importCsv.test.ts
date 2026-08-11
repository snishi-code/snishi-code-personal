import { describe, expect, it } from 'vitest';
import './setup';
import {
  CsvImportError,
  decodeCsvBytes,
  extractCsvTable,
  formatCsvLine,
  parseCsv,
} from '../src/domain/importCsv';

const utf8 = (text: string) => new TextEncoder().encode(text);
const withBom = (text: string) => {
  const body = utf8(text);
  const bytes = new Uint8Array(3 + body.length);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(body, 3);
  return bytes;
};

describe('decodeCsvBytes', () => {
  it('utf-8 を復号する', () => {
    expect(decodeCsvBytes(utf8('取引日,金額'), 'utf-8')).toBe('取引日,金額');
  });

  it('utf-8-sig は先頭 BOM を除去する', () => {
    expect(decodeCsvBytes(withBom('取引日,金額'), 'utf-8-sig')).toBe('取引日,金額');
  });

  it('utf-8-sig は BOM 無しでも受理する', () => {
    expect(decodeCsvBytes(utf8('a,b'), 'utf-8-sig')).toBe('a,b');
  });

  it('utf-8 では BOM を黙って剥がさない（列名の不一致で可視に失敗させる）', () => {
    expect(decodeCsvBytes(withBom('a,b'), 'utf-8')).toBe('\u{feff}a,b');
  });

  it('cp932 を復号する（TextEncoder では作れない固定バイト列 fixture）', () => {
    // Shift_JIS: 「日付,金額」= 93FA(日) 9574(付) 2C(,) 8BE0(金) 8A7A(額)。
    const sjis = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a]);
    expect(decodeCsvBytes(sjis, 'cp932')).toBe('日付,金額');
  });

  it('不正な utf-8 バイトは fatal で明示エラー', () => {
    const bad = new Uint8Array([0x61, 0xff, 0x62]);
    expect(() => decodeCsvBytes(bad, 'utf-8')).toThrowError(CsvImportError);
    try {
      decodeCsvBytes(bad, 'utf-8');
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-decode-failed');
    }
  });

  it('不正な cp932 バイト列（先行バイトで途切れ）は明示エラー', () => {
    expect(() => decodeCsvBytes(new Uint8Array([0x93]), 'cp932')).toThrowError(CsvImportError);
  });
});

describe('parseCsv', () => {
  it('引用内のカンマを分割しない', () => {
    const records = parseCsv('a,"1,400",b');
    expect(records).toHaveLength(1);
    expect(records[0]!.cells).toEqual(['a', '1,400', 'b']);
  });

  it('"" エスケープを 1 個の引用符へ戻す', () => {
    expect(parseCsv('"He said ""hi""",x')[0]!.cells).toEqual(['He said "hi"', 'x']);
  });

  it('引用内の改行を 1 レコードとして保持し、行番号は物理行を数える', () => {
    const records = parseCsv('"line1\nline2",a\nnext,b');
    expect(records).toHaveLength(2);
    expect(records[0]!.cells).toEqual(['line1\nline2', 'a']);
    expect(records[0]!.line).toBe(1);
    expect(records[0]!.raw).toBe('"line1\nline2",a');
    expect(records[1]!.line).toBe(3);
  });

  it('CRLF と LF の混在を扱い、raw は行終端を含まない', () => {
    const records = parseCsv('a,b\r\nc,d\ne,f\r\n');
    expect(records.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(records.map((r) => r.raw)).toEqual(['a,b', 'c,d', 'e,f']);
  });

  it('末尾空列を落とさない（a,b, は 3 セル）', () => {
    expect(parseCsv('a,b,')[0]!.cells).toEqual(['a', 'b', '']);
  });

  it('最終行の行終端は空レコードを生まない・終端なしの最終行は拾う', () => {
    expect(parseCsv('a\n')).toHaveLength(1);
    expect(parseCsv('a')).toHaveLength(1);
    expect(parseCsv('')).toHaveLength(0);
  });

  it('途中の空行は 1 セルの空レコードになる（捨てない）', () => {
    const records = parseCsv('a\n\nb');
    expect(records).toHaveLength(3);
    expect(records[1]!.cells).toEqual(['']);
  });

  it('閉じない引用は fail-closed', () => {
    try {
      parseCsv('a,"broken');
      expect.unreachable();
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-unclosed-quote');
    }
  });

  it('閉じ引用の直後のゴミは fail-closed', () => {
    try {
      parseCsv('"a"b,c');
      expect.unreachable();
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-invalid-quote');
    }
  });

  it('非引用フィールド途中の引用符は fail-closed', () => {
    expect(() => parseCsv('a"b,c')).toThrowError(CsvImportError);
  });

  it('区切り文字を指定できる（タブ）', () => {
    expect(parseCsv('a\tb\tc', { delimiter: '\t' })[0]!.cells).toEqual(['a', 'b', 'c']);
  });

  it('不正な区切り文字は拒否する', () => {
    expect(() => parseCsv('a', { delimiter: '"' })).toThrowError(CsvImportError);
    expect(() => parseCsv('a', { delimiter: ',,' })).toThrowError(CsvImportError);
  });
});

describe('formatCsvLine', () => {
  it('必要なセルだけ引用し、parseCsv と往復一致する', () => {
    const cells = ['plain', 'a,b', 'say "hi"', 'multi\nline', ''];
    const line = formatCsvLine(cells);
    expect(parseCsv(line)[0]!.cells).toEqual(cells);
  });
});

describe('extractCsvTable', () => {
  it('前置き行・ヘッダー・データ行に分割する', () => {
    const records = parseCsv('前置き\nh1,h2\n1,2\n3,4');
    const table = extractCsvTable(records, 1);
    expect(table.header).toEqual(['h1', 'h2']);
    expect(table.preamble).toHaveLength(1);
    expect(table.dataRecords).toHaveLength(2);
  });

  it('重複ヘッダーは fail-closed', () => {
    try {
      extractCsvTable(parseCsv('a,b,a\n1,2,3'), 0);
      expect.unreachable();
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-duplicate-header');
    }
  });

  it('空文字ヘッダーが複数あっても重複扱いしない（Excel 由来の末尾カンマ）', () => {
    // ヘッダー末尾のカンマ 2 個 = 空ヘッダー 2 列。名前付き列の参照は index で安全に
    // 解決でき、空名の列は DSL schema（min(1)）が参照を許さないため曖昧さは生まれない。
    const table = extractCsvTable(parseCsv('a,b,,\n1,2,3,4'), 0);
    expect(table.header).toEqual(['a', 'b', '', '']);
    expect(table.dataRecords[0]!.cells).toEqual(['1', '2', '3', '4']);
    // 空白だけのヘッダーセルも trim 後は空文字 = 同様に除外。
    expect(extractCsvTable(parseCsv('a, ,\t\n1,2,3'), 0).header).toEqual(['a', '', '']);
    // 名前付き列の重複は引き続き拒否する（空文字の除外が判定を緩めない）。
    expect(() => extractCsvTable(parseCsv('a,,a\n1,2,3'), 0)).toThrowError(CsvImportError);
  });

  it('ヘッダー行が存在しない位置は fail-closed', () => {
    try {
      extractCsvTable(parseCsv('a,b'), 5);
      expect.unreachable();
    } catch (e) {
      expect((e as CsvImportError).code).toBe('csv-header-row-missing');
    }
  });
});
