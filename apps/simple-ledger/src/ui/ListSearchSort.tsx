/*
 * 一覧の検索欄・並び替えトグルの共通部品（presentational・state は持たない）。
 * 仕訳一覧と「毎月のもの」が同じ DOM / 44px 担保（.list-sort）を共有する。
 * 並び替えの軸（key と表示ラベル）はこのファイルの LIST_SORT_AXES が単一の正本で、
 * 両画面はそれを map して axisItems を作る（画面ごとに違うのは data-ui だけ）。
 * 方向（昇順/降順）はどの軸でも常に選べる。
 */
import { Segmented, type SegmentedItem } from '@snishi/foundation/ui/Segmented';
import type { MessageKey } from '../i18n';

/** 並び替えの軸。両画面で同じ 3 つ（軸の集合そのものが共通の語彙）。 */
export type ListSortAxisKey = 'date' | 'amount' | 'name';

/**
 * 一覧の並び替え軸の正本（並び順もこの配列のとおりに出す）。
 * 軸の具体的な意味は画面ごとに違う（日付 = 仕訳日 / 終了日・開始日、
 * 名称 = 摘要 / 項目名）が、利用者から見た語彙は同じなのでラベルを共有する。
 * 軸を足す・文言を変えるときに触る場所はここ 1 つ。
 */
export const LIST_SORT_AXES: readonly { key: ListSortAxisKey; labelKey: MessageKey }[] = [
  { key: 'date', labelKey: 'listSort.date' },
  { key: 'amount', labelKey: 'listSort.amount' },
  { key: 'name', labelKey: 'listSort.name' },
];

/** Segmented から来る string を軸へ狭める（未知の値は日付へ倒す）。両画面で同じ規約。 */
export function listSortAxisKey(key: string): ListSortAxisKey {
  return LIST_SORT_AXES.find((axis) => axis.key === key)?.key ?? 'date';
}

/** 検索欄。Journal の生 input と同じ DOM（foundation TextInput は type="search" を持たない）。 */
export function SearchInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  dataUi,
}: {
  id: string;
  /** sr-only ラベル（視覚上は placeholder が説明する）。 */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  dataUi?: string;
}) {
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-ui={dataUi}
      />
    </>
  );
}

/**
 * 並び替えトグル（軸 + 方向の Segmented 2 本）。
 * どの軸でも方向を選べるので、方向側を隠す分岐は持たない。44px は .list-sort が担保する。
 */
export function SortControls({
  ariaLabel,
  axisItems,
  axisValue,
  onAxisChange,
  directionItems,
  directionValue,
  onDirectionChange,
  extraClassName,
}: {
  ariaLabel: string;
  axisItems: SegmentedItem[];
  axisValue: string;
  onAxisChange: (key: string) => void;
  directionItems: SegmentedItem[];
  directionValue: string;
  onDirectionChange: (key: string) => void;
  extraClassName?: string;
}) {
  return (
    <div
      className={`toolbar list-sort${extraClassName ? ` ${extraClassName}` : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      <Segmented value={axisValue} items={axisItems} onChange={onAxisChange} />
      <Segmented value={directionValue} items={directionItems} onChange={onDirectionChange} />
    </div>
  );
}
