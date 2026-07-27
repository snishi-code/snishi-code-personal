// 日時表示の共通フォーマッタ。
//
// `YYYY-MM-DD HH:MM` (ローカル時刻)。hospital-workspace 内で 4 箇所に同一実装が複製されていた
// fmtTimestamp を foundation へ集約したもの (2026-07-06)。0/欠落は空文字を返す (未同期表示用)。

export function fmtTimestamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
