/*
 * **文言の {placeholder} が実際に埋まっているかの静的検査。**
 *
 * 監査で `aria-label={t('dashboard.statDetail', { label: ... })}` が見つかった。
 * このテンプレートは '{label} {amount}、内訳を開く' で、{amount} を渡していないため
 * スクリーンリーダーが「収入 {amount}、内訳を開く」と読み上げていた。
 * 画面には出ない（aria-label は目で見えない）ので、通常の描画テストでは永久に捕まらない。
 *
 * 個別の描画テストを増やしても同型の抜けは防げないため、
 * **t() の呼び出し側と辞書のプレースホルダ集合を突き合わせる**機械的検査を置く。
 * インライン・オブジェクト以外の引数（動的な vars）は対象外＝判定不能として飛ばす。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ja } from '../src/i18n/ja';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return ['.ts', '.tsx'].includes(extname(e.name)) ? [full] : [];
  });
}

/** src[from] が '{' のとき、対応する '}' の直後位置を返す（文字列・入れ子を素朴に飛ばす）。 */
function matchBrace(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * オブジェクト・リテラル本文から深さ 1 のキー名を集める（短縮記法 { years } も拾う）。
 * スプレッド（...vars）が混じる場合は中身を静的に決められないので null（判定不能）を返す。
 */
function topLevelKeys(objectSource: string): string[] | null {
  const body = objectSource.slice(1, -1);
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      current += c;
      i++;
      while (i < body.length && body[i] !== quote) {
        current += body[i];
        i += body[i] === '\\' ? 2 : 1;
      }
      current += quote;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  segments.push(current);

  const keys: string[] = [];
  for (const raw of segments) {
    const segment = raw.trim();
    if (segment === '') continue;
    if (segment.startsWith('...')) return null; // 展開元が静的に分からない。
    let colon = -1;
    let d = 0;
    for (let i = 0; i < segment.length; i++) {
      const c = segment[i]!;
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') d--;
      else if (c === ':' && d === 0) {
        colon = i;
        break;
      }
    }
    const key = (colon === -1 ? segment : segment.slice(0, colon)).trim();
    keys.push(key.replace(/^['"`]|['"`]$/g, ''));
  }
  return keys;
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

type Call = { file: string; line: number; key: string; vars: string[] | null };

const CALL = /\bt\(\s*'([^']+)'/g;

function callsIn(file: string): Call[] {
  const src = readFileSync(file, 'utf8');
  const out: Call[] = [];
  for (const m of src.matchAll(CALL)) {
    const key = m[1]!;
    if (!(key in ja)) continue; // 文言キー以外の t( 呼び出し（別関数）は無視する。
    let i = m.index! + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    let vars: string[] | null = null;
    if (src[i] === ',') {
      i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] === '{') {
        const end = matchBrace(src, i);
        if (end > 0) vars = topLevelKeys(src.slice(i, end));
      }
      // '{' 以外（変数・スプレッド等）は判定不能として null のまま飛ばす。
    } else {
      vars = [];
    }
    out.push({ file, line: src.slice(0, m.index!).split('\n').length, key, vars });
  }
  return out;
}

describe('t() の呼び出しが辞書のプレースホルダを満たしている', () => {
  const calls = sourceFiles(join(process.cwd(), 'src')).flatMap(callsIn);

  it('検査対象の呼び出しを実際に拾えている（正規表現が空振りしていない）', () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(calls.some((c) => placeholders(ja[c.key as keyof typeof ja]).length > 0)).toBe(true);
  });

  it('渡し漏れたプレースホルダが無い', () => {
    const missing = calls
      .filter((c) => c.vars !== null)
      .flatMap((c) => {
        const need = placeholders(ja[c.key as keyof typeof ja]);
        const lack = need.filter((p) => !c.vars!.includes(p));
        return lack.length === 0
          ? []
          : [
              `${c.file.replace(process.cwd() + '/', '')}:${c.line} t('${c.key}') に {${lack.join('}, {')}} が無い`,
            ];
      });
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
