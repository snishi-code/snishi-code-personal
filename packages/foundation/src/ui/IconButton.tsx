/*
 * アイコン専用ボタン(44×44 のタップ領域)。アイコンだけでは意味が伝わらないため
 * aria-label(label)を必須にする。
 */
import type { ButtonHTMLAttributes } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** aria-label として付与する操作名(必須)。 */
  label: string;
  variant?: 'plain' | 'primary';
  dataUi?: string;
}

export function IconButton({
  label,
  variant = 'plain',
  type = 'button',
  className,
  dataUi,
  children,
  ...rest
}: IconButtonProps) {
  const classes = ['icon-btn'];
  if (variant === 'primary') classes.push('icon-btn--primary');
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} aria-label={label} data-ui={dataUi} {...rest}>
      {children}
    </button>
  );
}
