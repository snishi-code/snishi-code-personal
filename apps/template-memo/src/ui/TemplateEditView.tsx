/*
 * テンプレート編集画面。設定画面のローカル state から呼び、ルートは増やさない。
 * draft は deep copy し、保存時に normalizeTemplate を通す。全 section が落ちる場合は
 * durable state を変更せず fail-closed で通知する。
 */
import { useState, type ReactNode } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import {
  normalizeTemplate,
  type GroupDisplay,
  type ItemKind,
  type Template,
  type TemplateGroup,
  type TemplateItem,
  type TemplateSection,
} from '../domain/template';
import { errorText, s } from '../i18n';
import { UI } from '../ui-contract';
import type { AppRuntime } from './appRuntime';
import { useRegisterEditor } from './registries';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function moveInArray<T>(items: T[], index: number, direction: -1 | 1): void {
  const next = index + direction;
  if (index < 0 || next < 0 || index >= items.length || next >= items.length) return;
  const [item] = items.splice(index, 1);
  if (item !== undefined) items.splice(next, 0, item);
}

// DOM の select 値は許可リストで検証してから型に載せる (fail-closed: 未知値は無変更)。
const ITEM_KINDS: readonly ItemKind[] = ['text', 'number', 'fraction', 'select'];
const GROUP_DISPLAYS: readonly GroupDisplay[] = ['always', 'oncall', 'menu'];

export function morphItemKind(item: TemplateItem, kind: ItemKind): void {
  if (!ITEM_KINDS.includes(kind)) return;
  // number↔fraction は同じ数値系なので単位を引き継ぐ (旧回診 FormatEditDialog と同じ)。
  const numeric = (k: ItemKind) => k === 'number' || k === 'fraction';
  const keepUnit = numeric(item.kind) && numeric(kind) ? item.unit : undefined;
  item.kind = kind;
  delete item.unit;
  delete item.normal;
  delete item.options;
  if (keepUnit !== undefined) item.unit = keepUnit;
  if (kind === 'select') item.options = [s.tpl.itemOptionDefault];
}

function newItem(): TemplateItem {
  return { id: newId('itm'), label: '', kind: 'text' };
}

function newGroup(): TemplateGroup {
  return {
    id: newId('grp'),
    name: '',
    display: 'always',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    items: [newItem()],
  };
}

function newSection(): TemplateSection {
  return {
    id: newId('sec'),
    title: '',
    freeText: true,
    groups: [],
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

function CheckRow({
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

function RowTools({
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

const JOINERS = [
  { value: '\n', label: s.tpl.joinerNewline },
  { value: ', ', label: s.tpl.joinerCommaSpace },
  { value: '、', label: s.tpl.joinerToten },
  { value: '-', label: s.tpl.joinerHyphen },
  { value: ' ', label: s.tpl.joinerSpace },
];

const LABEL_SEPS = [
  { value: '：', label: s.tpl.labelSepColon },
  { value: ' ', label: s.tpl.labelSepSpace },
  { value: '', label: s.tpl.labelSepNone },
];

function selectOptions(candidates: { value: string; label: string }[], current: string) {
  return candidates.some((option) => option.value === current)
    ? candidates
    : [{ value: current, label: JSON.stringify(current) }, ...candidates];
}

export function TemplateEditView({
  runtime,
  template,
  onDone,
}: {
  runtime: AppRuntime;
  template: Template;
  onDone: () => void;
}) {
  useRegisterEditor(onDone);
  const toast = useToast();
  const [draft, setDraft] = useState<Template>(() => clone(template));
  const [busy, setBusy] = useState(false);

  function mutate(change: (next: Template) => void): void {
    setDraft((current) => {
      const next = clone(current);
      change(next);
      return next;
    });
  }

  function mutateSection(sectionId: string, change: (section: TemplateSection) => void): void {
    mutate((next) => {
      const section = next.sections.find((entry) => entry.id === sectionId);
      if (section) change(section);
    });
  }

  function mutateGroup(
    sectionId: string,
    groupId: string,
    change: (group: TemplateGroup) => void,
  ): void {
    mutateSection(sectionId, (section) => {
      const group = section.groups.find((entry) => entry.id === groupId);
      if (group) change(group);
    });
  }

  function mutateItem(
    sectionId: string,
    groupId: string,
    itemId: string,
    change: (item: TemplateItem) => void,
  ): void {
    mutateGroup(sectionId, groupId, (group) => {
      const item = group.items.find((entry) => entry.id === itemId);
      if (item) change(item);
    });
  }

  async function save(): Promise<void> {
    if (busy) return;
    const normalized = normalizeTemplate({ ...draft, updatedAt: Date.now() });
    if (!normalized) {
      toast.show(s.toast.saveFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      await runtime.store.saveTemplate(normalized);
      runtime.bump();
      toast.show(s.tpl.saved);
      onDone();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderOptions(sectionId: string, groupId: string, item: TemplateItem) {
    const options = item.options ?? [];
    return (
      <div className="templateEditOptions">
        <div className="field__label">{s.tpl.itemOptions}</div>
        {options.map((option, index) => (
          <div className="settingsField" key={`${item.id}:${index}`}>
            <input
              className="input"
              value={option}
              aria-label={s.tpl.itemOption(index + 1)}
              data-ui={UI.templateEdit.option}
              onChange={(event) =>
                mutateItem(sectionId, groupId, item.id, (next) => {
                  const values = [...(next.options ?? [])];
                  values[index] = event.target.value;
                  next.options = values;
                })
              }
            />
            <RowTools
              index={index}
              count={options.length}
              // 選択肢 0 個の select は normalizeItem が項目ごと落とすため、最後の 1 つは消させない。
              disableDelete={options.length === 1}
              onMove={(direction) =>
                mutateItem(sectionId, groupId, item.id, (next) =>
                  moveInArray((next.options ??= []), index, direction),
                )
              }
              onDelete={() =>
                mutateItem(sectionId, groupId, item.id, (next) => {
                  next.options = (next.options ?? []).filter((_, i) => i !== index);
                })
              }
            />
          </div>
        ))}
        <Button
          onClick={() =>
            mutateItem(sectionId, groupId, item.id, (next) => (next.options ??= []).push(''))
          }
        >
          {s.tpl.itemOptionAdd}
        </Button>
      </div>
    );
  }

  function renderItem(
    sectionId: string,
    groupId: string,
    item: TemplateItem,
    index: number,
    count: number,
  ) {
    return (
      <div className="templateEditItem" key={item.id} data-ui={UI.templateEdit.item}>
        <div className="formatListRow">
          <span className="pickerRowLabel">
            {s.tpl.items} {index + 1}
          </span>
          <RowTools
            index={index}
            count={count}
            onMove={(direction) =>
              mutateGroup(sectionId, groupId, (group) => moveInArray(group.items, index, direction))
            }
            onDelete={() =>
              mutateGroup(sectionId, groupId, (group) => {
                group.items = group.items.filter((entry) => entry.id !== item.id);
              })
            }
          />
        </div>
        <Field label={s.tpl.itemLabel}>
          <input
            className="input"
            value={item.label}
            data-ui={UI.templateEdit.field}
            onChange={(event) =>
              mutateItem(sectionId, groupId, item.id, (next) => (next.label = event.target.value))
            }
          />
        </Field>
        <div className="settingsField templateEditKindRow">
          <Field label={s.tpl.itemKind}>
            <select
              className="select"
              value={item.kind}
              data-ui={UI.templateEdit.kind}
              onChange={(event) =>
                mutateItem(sectionId, groupId, item.id, (next) =>
                  morphItemKind(next, event.target.value as ItemKind),
                )
              }
            >
              <option value="text">{s.tpl.itemKindText}</option>
              <option value="number">{s.tpl.itemKindNumber}</option>
              <option value="fraction">{s.tpl.itemKindFraction}</option>
              <option value="select">{s.tpl.itemKindSelect}</option>
            </select>
          </Field>
          {item.kind === 'text' ? (
            <Field label={s.tpl.itemNormal}>
              <input
                className="input"
                value={item.normal ?? ''}
                onChange={(event) =>
                  mutateItem(
                    sectionId,
                    groupId,
                    item.id,
                    (next) => (next.normal = event.target.value),
                  )
                }
              />
            </Field>
          ) : item.kind === 'select' ? null : (
            <Field label={s.tpl.itemUnit}>
              <input
                className="input"
                value={item.unit ?? ''}
                onChange={(event) =>
                  mutateItem(
                    sectionId,
                    groupId,
                    item.id,
                    (next) => (next.unit = event.target.value),
                  )
                }
              />
            </Field>
          )}
        </div>
        {item.kind === 'select' ? renderOptions(sectionId, groupId, item) : null}
        <CheckRow
          label={s.tpl.itemShowLabel}
          checked={item.showLabel !== false}
          onChange={(checked) =>
            mutateItem(sectionId, groupId, item.id, (next) => {
              if (checked) delete next.showLabel;
              else next.showLabel = false;
            })
          }
        />
      </div>
    );
  }

  function renderGroup(sectionId: string, group: TemplateGroup, index: number, count: number) {
    return (
      <section
        className="card panelCard templateEditGroup"
        key={group.id}
        data-ui={UI.templateEdit.group}
      >
        <div className="formatListRow">
          <span className="pickerRowLabel">{group.name || `${s.tpl.groups} ${index + 1}`}</span>
          <RowTools
            index={index}
            count={count}
            onMove={(direction) =>
              mutateSection(sectionId, (section) => moveInArray(section.groups, index, direction))
            }
            onDelete={() =>
              mutateSection(sectionId, (section) => {
                section.groups = section.groups.filter((entry) => entry.id !== group.id);
              })
            }
          />
        </div>
        <Field label={s.tpl.groupName}>
          <input
            className="input"
            value={group.name}
            onChange={(event) =>
              mutateGroup(sectionId, group.id, (next) => (next.name = event.target.value))
            }
          />
        </Field>
        <Field label={s.tpl.groupDisplay}>
          <select
            className="select"
            value={group.display}
            data-ui={UI.templateEdit.display}
            onChange={(event) => {
              const display = event.target.value as GroupDisplay;
              if (!GROUP_DISPLAYS.includes(display)) return;
              mutateGroup(sectionId, group.id, (next) => (next.display = display));
            }}
          >
            <option value="always">{s.tpl.groupDisplayAlways}</option>
            <option value="oncall">{s.tpl.groupDisplayOncall}</option>
            <option value="menu">{s.tpl.groupDisplayMenu}</option>
          </select>
        </Field>
        <Field label={s.tpl.groupJoiner}>
          <select
            className="select"
            value={group.joiner}
            onChange={(event) =>
              mutateGroup(sectionId, group.id, (next) => (next.joiner = event.target.value))
            }
          >
            {selectOptions(JOINERS, group.joiner).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.tpl.groupLabelSep}>
          <select
            className="select"
            value={group.labelSep}
            onChange={(event) =>
              mutateGroup(sectionId, group.id, (next) => (next.labelSep = event.target.value))
            }
          >
            {selectOptions(LABEL_SEPS, group.labelSep).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {group.items.map((item, itemIndex) =>
          renderItem(sectionId, group.id, item, itemIndex, group.items.length),
        )}
        <Button
          onClick={() => mutateGroup(sectionId, group.id, (next) => next.items.push(newItem()))}
        >
          {s.tpl.itemAdd}
        </Button>
      </section>
    );
  }

  function renderSection(section: TemplateSection, index: number, count: number) {
    return (
      <section
        className="card panelCard templateEditSection"
        key={section.id}
        data-ui={UI.templateEdit.section}
      >
        <div className="formatListRow">
          <span className="pickerRowLabel">
            {section.title || `${s.tpl.sections} ${index + 1}`}
          </span>
          <RowTools
            index={index}
            count={count}
            onMove={(direction) => mutate((next) => moveInArray(next.sections, index, direction))}
            onDelete={() =>
              mutate((next) => {
                next.sections = next.sections.filter((entry) => entry.id !== section.id);
              })
            }
          />
        </div>
        <Field label={s.tpl.sectionTitle}>
          <input
            className="input"
            value={section.title}
            onChange={(event) =>
              mutateSection(section.id, (next) => (next.title = event.target.value))
            }
          />
        </Field>
        <Field label={s.tpl.sectionNormal}>
          <input
            className="input"
            value={section.normal ?? ''}
            onChange={(event) =>
              mutateSection(section.id, (next) => (next.normal = event.target.value))
            }
          />
        </Field>
        <CheckRow
          label={s.tpl.sectionFreeText}
          checked={section.freeText}
          onChange={(checked) => mutateSection(section.id, (next) => (next.freeText = checked))}
        />
        {section.groups.map((group, groupIndex) =>
          renderGroup(section.id, group, groupIndex, section.groups.length),
        )}
        <Button onClick={() => mutateSection(section.id, (next) => next.groups.push(newGroup()))}>
          {s.tpl.groupAdd}
        </Button>
      </section>
    );
  }

  return (
    <section className="settingsView templateEditView" data-ui={UI.templateEdit.view}>
      <div className="card panelCard">
        <div className="panelLabel">{s.settings.template.editTitle}</div>
        <Field label={s.tpl.name}>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => mutate((next) => (next.name = event.target.value))}
          />
        </Field>
        <CheckRow
          label={s.tpl.includeProblems}
          checked={draft.includeProblems}
          onChange={(checked) => mutate((next) => (next.includeProblems = checked))}
        />
        <CheckRow
          label={s.tpl.includeHandover}
          checked={draft.includeHandover}
          onChange={(checked) => mutate((next) => (next.includeHandover = checked))}
        />
        <Field label={s.tpl.memoSection}>
          <select
            className="select"
            value={draft.memoSectionId ?? ''}
            data-ui={UI.templateEdit.memoSection}
            onChange={(event) =>
              mutate((next) => (next.memoSectionId = event.target.value || null))
            }
          >
            <option value="">{s.tpl.memoSectionNone}</option>
            {draft.sections.map((section, index) => (
              <option key={section.id} value={section.id}>
                {section.title || `${s.tpl.sections} ${index + 1}`}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {draft.sections.map((section, index) => renderSection(section, index, draft.sections.length))}
      <Button onClick={() => mutate((next) => next.sections.push(newSection()))}>
        {s.tpl.sectionAdd}
      </Button>

      <div className="card card--pad settingsRowActions templateEditActions">
        <Button disabled={busy} onClick={onDone}>
          {s.common.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          dataUi={UI.templateEdit.save}
          onClick={() => void save()}
        >
          {s.common.save}
        </Button>
      </div>
    </section>
  );
}
