/*
 * 仕訳シートの各ページ下部に置く「まとめカード」（v13.15 §2.2・4 ページ同一解剖）。
 * フィールド群 + 自動入力のヒント + このカード、が各ページの骨格。
 * 説明帯は置かない（作者確定 2026-08-22）— 導出値の要約だけを名乗る。
 */
import type { ReactNode } from 'react';

export function StepSummaryCard({
  label,
  value,
  note,
  dataUi,
}: {
  label: string;
  value: ReactNode;
  /** 値の下の補足（合計一致・縮退の説明など）。 */
  note?: ReactNode;
  dataUi?: string;
}) {
  return (
    <div className="card card--pad" data-ui={dataUi}>
      <div className="kv">
        <span className="muted">{label}</span>
        <span>{value}</span>
      </div>
      {note !== undefined ? (
        <p className="field__hint" style={{ marginBottom: 0 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
