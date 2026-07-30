/*
 * ステータス（5色・固定意味）の表示部品と循環ロジック。
 * 色の実体は app.css の .tm-status-dot[data-status=…]（変数は app-theme.css の --status-*）。
 * 意味の正本は domain/types.ts の STATUS コメント（未/途中/済/転記済/特記）。
 */
import type { CSSProperties } from 'react';
import { STATUS, type SubjectStatus } from '../domain/types';
import { t } from '../i18n';

/** 表示順（StatusPicker の並び。ワンタップ循環も青以外はこの順）。 */
export const STATUS_ORDER: readonly SubjectStatus[] = Object.freeze([
  STATUS.NONE,
  STATUS.YELLOW,
  STATUS.GREEN,
  STATUS.GRAY,
  STATUS.BLUE,
]);

/** ステータスの表示文言（i18n 経由）。 */
export function statusLabel(status: SubjectStatus): string {
  return t(`status.${status}`);
}

/** ステータス色の丸（表示専用）。タップさせる場合は呼び出し側が button で包む。 */
export function StatusDot({ status }: { status: SubjectStatus }) {
  return <span className="tm-status-dot" data-status={status} aria-hidden="true" />;
}

/**
 * ワンタップ循環: 未→途中→済→転記済→未。青=特記は循環に入れない
 * （特記をワンタップで消さない。青の付け外しは StatusPicker から明示的に行う）。
 */
export function cycleStatus(s: SubjectStatus): SubjectStatus {
  switch (s) {
    case STATUS.NONE:
      return STATUS.YELLOW;
    case STATUS.YELLOW:
      return STATUS.GREEN;
    case STATUS.GREEN:
      return STATUS.GRAY;
    case STATUS.GRAY:
      return STATUS.NONE;
    default:
      // 青=特記はそのまま
      return s;
  }
}

// チップの選択表示（白文字 on teal-700 = WCAG AA。app-theme.css の変数を参照）。
const chipBase: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const chipSelected: CSSProperties = {
  ...chipBase,
  background: 'var(--primary-fill)',
  borderColor: 'var(--primary-fill)',
  color: 'var(--on-primary)',
};

/** 5 色の横並びピッカー（44px タップ領域 = .tm-chip・色丸+ラベル付き）。 */
export function StatusPicker({
  value,
  onChange,
}: {
  value: SubjectStatus;
  onChange: (s: SubjectStatus) => void;
}) {
  return (
    <div className="tm-chip-row">
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          type="button"
          className="tm-chip"
          aria-pressed={s === value}
          style={s === value ? chipSelected : chipBase}
          onClick={() => onChange(s)}
        >
          <StatusDot status={s} />
          {statusLabel(s)}
        </button>
      ))}
    </div>
  );
}
