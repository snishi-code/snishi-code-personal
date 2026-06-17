/*
 * セグメントコントロール（タブ切り替え）。
 * 選択状態は aria-selected で示す（色だけに依存しない）。
 * role="tablist" / "tab" は複雑すぎるため使わず、
 * button + aria-selected のシンプル実装にする。
 */
import type { ReactNode } from 'react';

export interface SegmentedItem {
  key: string;
  label: ReactNode;
  dataUi?: string;
}

export function Segmented({
  items,
  value,
  onChange,
  dataUi,
}: {
  items: SegmentedItem[];
  /** 現在選択中の key */
  value: string;
  onChange: (key: string) => void;
  dataUi?: string;
}) {
  return (
    <div className="segmented" data-ui={dataUi}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="segmented__btn"
          aria-selected={item.key === value}
          data-ui={item.dataUi}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
