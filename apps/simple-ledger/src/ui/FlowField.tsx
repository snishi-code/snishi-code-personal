/*
 * 「貸方 → 借方」の外枠マークアップ（.field の中に .field__hint と .flow を兄弟で並べる）。
 * ロジック・state・科目候補の構築は一切持たない（source / destination は ReactNode スロット）。
 * ホームの簿記編集（EntrySheet の 3 箇所）と定期ルールのシートが同じ見た目を共有する 1 本。
 * 許可 role の違い（簿記編集 = MANUAL_ROLES / 定期 = RECURRING_POSTABLE_ROLES）を消さないため、
 * AccountPicker やその groups をここで受け取らない。
 */
import type { ReactNode } from 'react';

export function FlowField({
  hint,
  dataUi,
  source,
  destination,
}: {
  hint?: string;
  dataUi?: string;
  source: ReactNode;
  destination: ReactNode;
}) {
  return (
    <div className="field" data-ui={dataUi}>
      {hint !== undefined ? <span className="field__hint">{hint}</span> : null}
      <div className="flow">
        <div className="flow__side">{source}</div>
        <div className="flow__arrow" aria-hidden="true">
          →
        </div>
        <div className="flow__side">{destination}</div>
      </div>
    </div>
  );
}
