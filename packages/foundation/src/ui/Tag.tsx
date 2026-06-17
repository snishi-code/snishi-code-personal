/*
 * バッジ / タグ。color=primary はカテゴリ色に追従する（--primary 変数経由）。
 * テキストとアイコンを併用して色だけに依存しない表示にする。
 */
import type { ReactNode } from 'react';

export type TagVariant = 'primary' | 'neutral' | 'warning' | 'danger';

export function Tag({
  variant = 'primary',
  children,
  className,
}: {
  variant?: TagVariant;
  children: ReactNode;
  className?: string;
}) {
  const classes = ['tag', `tag--${variant}`];
  if (className) classes.push(className);
  return <span className={classes.join(' ')}>{children}</span>;
}
