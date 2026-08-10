/*
 * DSL 検証エラーの日本語化（ui/importDslIssueText.ts）。
 *  - 代表的な検証失敗（未知キー・型違い・必須欠落・候補違い・上限）が日本語で読めること
 *  - **zod の英語 message が生で出ないこと**（未知 code のフォールバック込み）
 *  - schema 側で日本語を書いた custom issue はそのまま見せること
 */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { dslIssueText, dslIssuesText } from '../src/ui/importDslIssueText';
import { parseImportProfileDsl } from '../src/domain/importDsl';
import { PAYPAY_DSL } from '../src/domain/importProfilePresets';

/** DSL を検証して ZodError を取り出す（通ってしまったらテストの前提が壊れている）。 */
function issuesOf(value: unknown): ZodError['issues'] {
  try {
    parseImportProfileDsl(value);
  } catch (e) {
    if (e instanceof ZodError) return e.issues;
    throw e;
  }
  throw new Error('検証が通ってしまった（不正な DSL を用意すること）');
}

/** 1 件目の issue の日本語文言（元の値を渡して必須欠落と型違いを区別させる）。 */
function firstText(value: unknown): string {
  return dslIssueText(issuesOf(value)[0]!, value);
}

/** zod の既定 message（英語）に出てくる語。表示文言に混ざっていないことの検査に使う。 */
const ZOD_ENGLISH = [
  'Invalid',
  'invalid',
  'Unrecognized',
  'expected',
  'Expected',
  'received',
  'Too small',
  'Too big',
  'option',
  'discriminator',
  'characters',
  'items',
];

function expectNoZodEnglish(text: string): void {
  for (const word of ZOD_ENGLISH) {
    expect(text, `英語が混ざっている: ${text}`).not.toContain(word);
  }
}

describe('DSL 検証エラーの日本語化 — 代表的な失敗', () => {
  it('未知キーは「使えない項目」としてキー名つきで出る', () => {
    const text = firstText({ ...PAYPAY_DSL, bogus: true });
    expect(text).toBe('DSL 全体: 使えない項目があります（bogus）');
    expectNoZodEnglish(text);
  });

  it('型違いは場所と期待する型が日本語で出る', () => {
    const text = firstText({
      ...PAYPAY_DSL,
      fileFormat: { ...PAYPAY_DSL.fileFormat, headerRowIndex: 'いち' },
    });
    expect(text).toBe('ファイル形式 > ヘッダー行の位置: 数値で指定してください');
    expectNoZodEnglish(text);
  });

  it('必須欠落は「必須の項目がありません」になる（型違いと区別する）', () => {
    const text = firstText({ dslVersion: 1 });
    expect(text).toBe('ファイル形式: 必須の項目がありません');
    expectNoZodEnglish(text);
  });

  it('元の値を渡さない場合でも英語は出ない（型の文言へ倒す）', () => {
    const text = dslIssueText(issuesOf({ dslVersion: 1 })[0]!);
    expect(text).toBe('ファイル形式: オブジェクトで指定してください');
    expectNoZodEnglish(text);
  });

  it('候補外の値（enum）は候補を並べて出す', () => {
    const text = firstText({
      ...PAYPAY_DSL,
      fileFormat: { ...PAYPAY_DSL.fileFormat, encoding: 'sjis' },
    });
    expect(text).toBe(
      'ファイル形式 > 文字コード: utf-8、utf-8-sig、cp932 のいずれかを指定してください',
    );
    expectNoZodEnglish(text);
  });

  it('固定値（dslVersion）は「1 を指定してください」になる', () => {
    const text = firstText({ ...PAYPAY_DSL, dslVersion: 2 });
    expect(text).toBe('DSL 版: 1 を指定してください');
    expectNoZodEnglish(text);
  });

  it('判別子違いは候補（演算子の一覧）つきで、配列の位置は「n 番目」で出る', () => {
    const text = firstText({
      ...PAYPAY_DSL,
      kindRules: [{ when: { op: 'regex', column: '取引内容', value: 'x' }, kind: 'k' }],
    });
    expect(text).toBe(
      '行種の分類 > 1 番目 > 条件 > 演算子: eq、prefix、suffix、contains、and、or、not のいずれかを指定してください',
    );
    expectNoZodEnglish(text);
  });

  it('件数・文字数の上限下限は単位つきの日本語になる', () => {
    const empty = firstText({ ...PAYPAY_DSL, kindRules: [] });
    expect(empty).toBe('行種の分類: 1 件以上が必要です');
    expectNoZodEnglish(empty);

    const tooLong = firstText({
      ...PAYPAY_DSL,
      kindRules: [{ when: { op: 'eq', column: 'x'.repeat(200), value: 'a' }, kind: 'k' }],
    });
    expect(tooLong).toBe('行種の分類 > 1 番目 > 条件 > 列名: 120 文字以下にしてください');
    expectNoZodEnglish(tooLong);
  });

  it('schema 側で書いた日本語の custom message はそのまま見せる', () => {
    const text = firstText({
      ...PAYPAY_DSL,
      fileFormat: { ...PAYPAY_DSL.fileFormat, delimiter: '"' },
    });
    expect(text).toBe('区切り文字に引用符・改行は使えません');
    expectNoZodEnglish(text);
  });
});

describe('DSL 検証エラーの日本語化 — 未知 code のフォールバック', () => {
  it('対応表に無い code は「<場所> の値が不正です」へ倒す（英語 message を出さない）', () => {
    // 将来 zod が増やす code / このアプリが使っていない code の代表として合成する。
    const unknownIssue = {
      code: 'not_multiple_of',
      path: ['fileFormat', 'headerRowIndex'],
      message: 'Invalid number: must be a multiple of 5',
    } as unknown as ZodError['issues'][number];
    const text = dslIssueText(unknownIssue);
    expect(text).toBe('ファイル形式 > ヘッダー行の位置 の値が不正です');
    expectNoZodEnglish(text);
  });

  it('英語の custom message はそのまま出さずフォールバックする', () => {
    const englishCustom = {
      code: 'custom',
      path: ['kindRules'],
      message: 'Invalid input',
    } as unknown as ZodError['issues'][number];
    const text = dslIssueText(englishCustom);
    expect(text).toBe('行種の分類 の値が不正です');
    expectNoZodEnglish(text);
  });

  it('対応表に無いフィールド名は原文のまま場所として出る（貼った JSON のキーを特定できる）', () => {
    const unknownField = {
      code: 'not_multiple_of',
      path: ['whatever', 3],
      message: 'Invalid number',
    } as unknown as ZodError['issues'][number];
    expect(dslIssueText(unknownField)).toBe('whatever > 4 番目 の値が不正です');
  });
});

describe('DSL 検証エラーの日本語化 — 画面に出る文言全体', () => {
  it('複数 issue をまとめても英語は混ざらない', () => {
    const broken = {
      dslVersion: 2,
      fileFormat: { encoding: 'sjis', delimiter: ',,', headerRowIndex: -1 },
      columns: 'これは文字列',
      kindRules: [],
      bogus: { nested: true },
    };
    let text = '';
    try {
      parseImportProfileDsl(broken);
    } catch (e) {
      text = dslIssuesText(e, broken);
    }
    expect(text).toContain('DSL の検証に失敗しました');
    expectNoZodEnglish(text);
  });

  it('ZodError 以外の例外は既存の errorText 経路（日本語）へ渡す', () => {
    expect(dslIssuesText(new Error('読み取りに失敗しました'))).toBe('読み取りに失敗しました');
  });
});
