// 定型文 (RoundsConfig.textSnippets) の今回メモへの挿入 (純関数)。
//
// 定型文は「今回メモに展開するテキスト部品」— 今回メモが唯一の漏斗なので、挿入さえすれば
// 電子カルテQR・定型清書・AI整形へそのまま流れる (新しい統合コストを作らない・2026-07-24)。

/**
 * 今回メモの末尾へ定型文本文を追記した文字列を返す。
 * メモが空なら本文だけ。非空なら改行 1 つで区切る (末尾の余分な空行は増やさない)。
 */
export function appendSnippetToMemo(memo: string, body: string): string {
  const current = String(memo ?? '');
  const text = String(body ?? '');
  if (!text) return current;
  if (!current.trim()) return text;
  return `${current.replace(/\n+$/, '')}\n${text}`;
}
