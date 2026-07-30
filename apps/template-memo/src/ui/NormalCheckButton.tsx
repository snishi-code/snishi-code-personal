// 正常文チェック (✓) の長押しボタン (2026-06 フィードバック: ミスタップ対策)。
//
// 単純タップでは発火せず、NORMAL_HOLD_MS の長押しで確定する。誤接触で値が書かれる
// ことを防ぎつつ、軽快に入力できる長さに調整 (350ms)。押下中は CSS .pressing の
// 充填アニメで「押せている」ことを可視化し、確定時に hapticTick を鳴らすのは
// 呼び出し側の責務 (書き込み成功と対で)。
//
// キーボード操作 (Enter/Space) はミスタップの懸念がないため即時発火する (a11y)。

import { useEffect, useRef, useState } from 'react';
import { UI } from '../ui-contract';

/** 長押しの確定時間 (ms)。CSS の hrNormalHold アニメ時間と同期させること。 */
export const NORMAL_HOLD_MS = 350;

export function NormalCheckButton({
  on,
  title,
  ariaLabel,
  ariaPressed,
  onTrigger,
}: {
  /** 押下済み (preset) 表示 */
  on: boolean;
  title: string;
  ariaLabel: string;
  /** aria-pressed を出すか (表示モードのトグルのみ true 系を渡す) */
  ariaPressed?: boolean;
  onTrigger: () => void;
}) {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef(onTrigger);
  useEffect(() => {
    triggerRef.current = onTrigger;
  });

  const cancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPressing(false);
  };

  // unmount 時のタイマー残留防止
  useEffect(() => cancel, []);

  const start = () => {
    cancel();
    setPressing(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPressing(false);
      triggerRef.current();
    }, NORMAL_HOLD_MS);
  };

  return (
    <button
      type="button"
      className={`formatNormalBtn${on ? ' on' : ''}${pressing ? ' pressing' : ''}`}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      data-ui={UI.projection.normalBtn}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerRef.current();
        }
      }}
    >
      ✓
    </button>
  );
}
