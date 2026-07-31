import type { ReactNode } from 'react';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { s } from '../i18n';

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function moveInArray<T>(items: T[], index: number, direction: -1 | 1): void {
  const next = index + direction;
  if (index < 0 || next < 0 || index >= items.length || next >= items.length) return;
  const [item] = items.splice(index, 1);
  if (item !== undefined) items.splice(next, 0, item);
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

export function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settingsRadioRow">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function RowTools({
  index,
  count,
  onMove,
  onDelete,
  disableDelete = false,
}: {
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  disableDelete?: boolean;
}) {
  return (
    <span className="formatListActions">
      <IconButton label={s.tpl.moveUp} disabled={index === 0} onClick={() => onMove(-1)}>
        ↑
      </IconButton>
      <IconButton label={s.tpl.moveDown} disabled={index === count - 1} onClick={() => onMove(1)}>
        ↓
      </IconButton>
      <IconButton label={s.common.delete} disabled={disableDelete} onClick={onDelete}>
        <Icon name="delete" size={18} />
      </IconButton>
    </span>
  );
}

export const JOINERS = [
  { value: '\n', label: s.tpl.joinerNewline },
  { value: ', ', label: s.tpl.joinerCommaSpace },
  { value: '、', label: s.tpl.joinerToten },
  { value: '-', label: s.tpl.joinerHyphen },
  { value: ' ', label: s.tpl.joinerSpace },
];

export const LABEL_SEPS = [
  { value: '：', label: s.tpl.labelSepColon },
  { value: ' ', label: s.tpl.labelSepSpace },
  { value: '', label: s.tpl.labelSepNone },
];

export function selectOptions(candidates: { value: string; label: string }[], current: string) {
  return candidates.some((option) => option.value === current)
    ? candidates
    : [{ value: current, label: JSON.stringify(current) }, ...candidates];
}
