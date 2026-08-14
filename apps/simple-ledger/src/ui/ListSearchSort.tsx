/*
 * 一覧の検索欄・並び替えトグルの共通部品（presentational・state は持たない）。
 * 仕訳一覧と「毎月のもの」が同じ DOM / 44px 担保（.list-sort）を共有する。
 * 軸の選択肢は画面ごとに違う（仕訳 = 日付/金額、毎月のもの = 日付/金額/名称）ため、
 * items は呼び出し側から渡す。方向（昇順/降順）はどの軸でも常に選べる。
 */
import { Segmented, type SegmentedItem } from '@snishi/foundation/ui/Segmented';

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
