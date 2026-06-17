// 移植元: snishi-code-personal/simple-ledger-src/src/i18n/index.ts (辞書固定 t() をファクトリへ汎用化)

export interface I18n<T extends Record<string, string>> {
  t: (key: keyof T & string, params?: Record<string, string | number>) => string;
}

/**
 * 型安全な key-value i18n。`{name}` 形式のプレースホルダを補間する。
 * 未知キーはキー文字列をそのまま返す (fail-visible: 画面に出して開発時に気付く)。
 */
export function createI18n<T extends Record<string, string>>(strings: T): I18n<T> {
  // 同一キーで console を埋めないため、警告は 1 キー 1 回。
  const missing = new Set<string>();

  function t(key: keyof T & string, params?: Record<string, string | number>): string {
    let template: string | undefined = strings[key];
    if (template == null) {
      if (!missing.has(key)) {
        missing.add(key);
        console.warn('[i18n] missing key:', key);
      }
      template = key;
    }
    if (!params) return template;
    // 1 パス置換: 置換後の値に含まれる "{x}" を再走査しない (誤展開防止)。
    // 未提供のプレースホルダは残す (fail-visible)。
    return template.replace(/\{(\w+)\}/g, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  }

  return { t };
}
