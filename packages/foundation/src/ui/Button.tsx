/*
 * 汎用ボタン。min-height 44px(タップ領域)は .btn が担保する。
 * type 既定は 'button'(フォーム内に置いても暗黙 submit しない)。
 */
import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'secondary' | 'primary' | 'danger' | 'ghost';
  block?: boolean;
  dataUi?: string;
}

export function Button({
  variant = 'secondary',
  block = false,
  type = 'button',
  className,
  dataUi,
  ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant !== 'secondary') classes.push(`btn--${variant}`);
  if (block) classes.push('btn--block');
  if (className) classes.push(className);
  return <button type={type} className={classes.join(' ')} data-ui={dataUi} {...rest} />;
}
