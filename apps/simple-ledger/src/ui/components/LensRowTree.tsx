/*
 * 3 レンズ共通のラベル列（v13.6 H3・作者確定 2026-08-18）。
 *
 * **レンズは右ペインの描画を交換するだけ**で、左のラベル列は線分 / 数値 / グラフで同じもの。
 * 見た目の正は線分レンズ（箱と科目の木・箱ごとの色分け・タップで科目を露出）で、
 * ここはその実装を 1 か所へ移したもの。レンズ側は自前のラベル列も凡例も持たない。
 *
 * 1 行の中身（左から）:
 *  - **チェックボックス** = その行を右ペインへ出すか。3 レンズで共有し、グラフでは
 *    そのまま系列選択（凡例）を兼ねる。画面ローカル・保存しない・既定は全 ON。
 *  - **展開トグル**（子を持つ行だけ）= 箱をタップして科目を露出する。`aria-expanded`。
 *  - 行の名前。左端の縦罫が箱の色（`--lens-accent`）。
 *
 * 行の並び・親子は `domain/lensRows`（= 表示順マスタ）が正本で、ここでは並べ替えない。
 * タップ領域は 44px（`--tap`）。チェックできない行（グラフレンズのフロー行）は
 * `disabled` + 理由を読み上げる（見た目だけ死んだ操作を置かない）。
 */
import type { CSSProperties } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import type { LensRowKind, LensRowNode } from '../../domain/lensRows';
import { flattenLensRows } from '../../domain/lensRows';
import type { DisplaySectionKey } from '../../domain/displayOrder';
import { ACCOUNT_ACCENTS, displayBoxLook, type AccountAccent } from '../accountBoxes';
import { t, type MessageKey } from '../../i18n';
import { UI } from '../../ui-contract';

/**
 * ラベル列の幅（px）。CSS は JS のこの値を custom property で受け取り、可視範囲の計算も
 * 同じ値を使う（3 レンズで列幅がずれると「同じ窓」が成り立たない）。
 */
export const LENS_LABEL_WIDTH = 156;
/** 狭幅（CSS の @media (max-width: 480px) と同じ境界）。 */
export const LENS_LABEL_WIDTH_NARROW = 144;

export function lensLabelWidth(clientWidth: number): number {
  return clientWidth <= 480 ? LENS_LABEL_WIDTH_NARROW : LENS_LABEL_WIDTH;
}

/** 恒等行の名前。**ホームのカードと同じメッセージキー**（語彙を 2 か所に持たない）。 */
const SECTION_LABEL_KEYS: Record<DisplaySectionKey, MessageKey> = {
  revenue: 'dashboard.revenue',
  expense: 'dashboard.expense',
  net: 'dashboard.netIncome',
  totalAssets: 'dashboard.assets',
  totalLiabilities: 'dashboard.liabilities',
  netAssets: 'dashboard.netAssets',
};

/** 描画に必要なところまで解決した 1 行（並びは `domain/lensRows` が決めたまま）。 */
export interface LensRowView {
  id: string;
  kind: LensRowKind;
  depth: number;
  label: string;
  accent: AccountAccent;
  /** 箱の行か（背景・文字色の強弱）。 */
  heading: boolean;
  /** 恒等行か（式で出る行なので太字）。 */
  emphasis: boolean;
  hasChildren: boolean;
  expanded: boolean;
  checked: boolean;
  /** チェックを受け付けない理由（読み上げる）。undefined = 操作できる。 */
  disabledReason?: string;
  /** 値・帯の対応づけに使う元ノード。 */
  node: LensRowNode;
}

export interface BuildLensRowViewsOptions {
  tree: readonly LensRowNode[];
  expanded: ReadonlySet<string>;
  /** チェックが**外れている**行（既定は全 ON なので、持つのは OFF の側）。 */
  hidden: ReadonlySet<string>;
  /** その行のチェックを受け付けない理由（レンズ固有）。 */
  disabledReason?: (node: LensRowNode) => string | undefined;
}

/** 木を 1 本の行配列へ。ラベル・色の解決もここで済ませ、レンズ側には持ち込まない。 */
export function buildLensRowViews({
  tree,
  expanded,
  hidden,
  disabledReason,
}: BuildLensRowViewsOptions): LensRowView[] {
  return flattenLensRows(tree, expanded).map(({ node, depth }) => {
    const reason = disabledReason?.(node);
    return {
      id: node.id,
      kind: node.kind,
      depth,
      label: lensRowLabel(node),
      accent: lensRowAccent(node),
      heading: node.kind === 'box',
      emphasis: node.kind === 'identity',
      hasChildren: node.children.length > 0,
      expanded: expanded.has(node.id),
      checked: !hidden.has(node.id),
      ...(reason !== undefined ? { disabledReason: reason } : {}),
      node,
    };
  });
}

function lensRowLabel(node: LensRowNode): string {
  if (node.kind === 'box' && node.boxKey !== undefined) {
    return t(displayBoxLook(node.boxKey).labelKey);
  }
  if (node.kind === 'identity' && node.sectionKey !== undefined) {
    return t(SECTION_LABEL_KEYS[node.sectionKey]);
  }
  return node.name ?? '';
}

/**
 * 行の色。箱に属する行は箱の色（線分レンズの色分けの正本）。
 * 恒等行は箱ではない（式で出る行）ので、純資産の箱と同じ中立色で名乗る。
 */
function lensRowAccent(node: LensRowNode): AccountAccent {
  return node.boxKey !== undefined ? displayBoxLook(node.boxKey).accent : ACCOUNT_ACCENTS.equity;
}

/**
 * ラベル列の 1 セルの中身。器（`div` / `th`）はレンズ側が用意し、中身はここが持つ
 * ＝ 3 レンズで同じ DOM・同じ CSS になる。
 */
export function LensRowLabel({
  row,
  onToggle,
  onCheckChange,
}: {
  row: LensRowView;
  onToggle: (id: string) => void;
  onCheckChange: (id: string, checked: boolean) => void;
}) {
  const disabled = row.disabledReason !== undefined;
  const reasonId = disabled ? `lens-row-reason-${row.id.replace(/[^\w-]/g, '_')}` : undefined;
  return (
    <>
      <input
        type="checkbox"
        className="lens-row__check"
        checked={row.checked}
        disabled={disabled}
        aria-label={t('lens.showRow', { name: row.label })}
        {...(reasonId !== undefined ? { 'aria-describedby': reasonId } : {})}
        onChange={(event) => onCheckChange(row.id, event.target.checked)}
        data-ui={UI.timeline.rowCheck}
        data-row-key={row.id}
      />
      {reasonId !== undefined ? (
        <span className="sr-only" id={reasonId}>
          {row.disabledReason}
        </span>
      ) : null}
      {row.hasChildren ? (
        <button
          type="button"
          className="lens-row__toggle"
          aria-expanded={row.expanded}
          onClick={() => onToggle(row.id)}
          data-ui={UI.timeline.rowToggle}
          data-row-key={row.id}
          title={row.label}
        >
          <Icon name={row.expanded ? 'expand' : 'chevronRight'} size={16} />
          <span className="lens-row__text">{row.label}</span>
        </button>
      ) : (
        <span className="lens-row__text lens-row__text--leaf" title={row.label}>
          {row.label}
        </span>
      )}
    </>
  );
}

/** ラベル列のセルへ付ける class と custom property（器の種類によらず同じ見た目にする）。 */
export function lensRowLabelProps(row: LensRowView): {
  className: string;
  style: CSSProperties;
  'data-ui': string;
  'data-row-key': string;
} {
  return {
    className: [
      'lens-row__label',
      row.heading ? 'lens-row__label--heading' : 'lens-row__label--detail',
      row.emphasis ? 'lens-row__label--emphasis' : '',
      row.checked ? '' : 'lens-row__label--off',
    ]
      .filter(Boolean)
      .join(' '),
    style: { '--lens-accent': row.accent, '--lens-depth': row.depth } as CSSProperties,
    'data-ui': UI.timeline.rowLabel,
    'data-row-key': row.id,
  };
}
