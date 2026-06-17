/*
 * タグの複数選択チップ（ネイティブ checkbox）。
 */
import { Icon } from '@snishi/foundation/ui/Icon';
import type { Tag } from '../domain/types';
import { t } from '../i18n';

export function TagPicker({
  label,
  tags,
  value,
  onChange,
  hint,
  dataUi,
}: {
  label: string;
  tags: Tag[];
  value: string[];
  onChange: (ids: string[]) => void;
  hint?: string;
  dataUi?: string;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <fieldset className="field picker" data-ui={dataUi}>
      <legend className="field__label">{label}</legend>
      {hint ? <span className="field__hint">{hint}</span> : null}
      {tags.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          {t('tags.noneForScope')}
        </p>
      ) : (
        <div className="picker__chips">
          {tags.map((tag) => (
            <label className="chip" key={tag.id}>
              <input
                type="checkbox"
                className="sr-only"
                checked={value.includes(tag.id)}
                onChange={() => toggle(tag.id)}
              />
              <span className="chip__check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
              <span className="chip__text">{tag.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
