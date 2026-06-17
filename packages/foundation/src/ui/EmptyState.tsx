/*
 * 空状態の表示。リストが 0 件のときに中央寄せでメッセージと任意の CTA を表示する。
 */
import type { ReactNode } from 'react';

export function EmptyState({
  message,
  cta,
}: {
  message: string;
  /** 追加ボタン等のアクション（省略可） */
  cta?: ReactNode;
}) {
  return (
    <div className="empty">
      <p>{message}</p>
      {cta ? <div className="empty__cta">{cta}</div> : null}
    </div>
  );
}
