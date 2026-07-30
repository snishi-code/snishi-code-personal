// 回診入力カード (コピー元: hospital-workspace/rounds/ui/ProjectionFormCard.tsx)。
// 固定フォーム (fixedFields) をテンプレート合成エンジンの群 (TemplateGroup) へ差し替えた。
//
// 仕様:
//   - 現在テンプレートの全場所を表示する（フォーマットが無い場所も見出しを残す）。
//   - 展開 (always) 群: 行ごとの入力を patient.projectedValues (FormValues) へ write-through 保存。
//     text 項目は項目名の右に正常文チェックを置く。手入力は openEditor で守る。
//   - 呼び出し (oncall) / メニュー (menu) 群: シートの値を同じ projectedValues へ保存。
//   - oncall/menu 群は値が入ると展開カードへ昇格し、全消去で入口へ戻る。
//   - 場所 (section) ごとに見出し・展開カード・呼び出しチップ・メニューをまとめる。
//   - 値の読み書きは必ず domain/formValues.ts のヘルパ経由。
//   - 患者は pid で捕捉する (並び替えで別患者へ書かないため)。MemoCards と同じ write-through。

import { useRef, useState, type RefObject } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from '@snishi/foundation/ui/Modal';
import type { FormValues, Patient, NumericEntry, TextEntry } from '../domain/types';
import {
  decidePresetToggle,
  groupHasInput,
  manualTextEntry,
  normalizeTextEntry,
  numericEntry,
  readGroupValues,
  readNumericEntry,
  readSelectValue,
  readTextValue,
} from '../domain/formValues';
import type { Template, TemplateGroup, TemplateItem, TemplateSection } from '../domain/template';
import type { AppRuntime } from './appRuntime';
import { useRegisterOverlay } from './registries';
import { hapticTick } from './feedback';
import { s } from '../i18n';
import { UI } from '../ui-contract';
import { NormalCheckButton } from './NormalCheckButton';

export function partitionSectionGroups(section: TemplateSection, values: FormValues) {
  const hasInput = (group: TemplateGroup) => groupHasInput(readGroupValues(values, group.id));
  return {
    shown: section.groups.filter((group) => group.display === 'always' || hasInput(group)),
    oncall: section.groups.filter((group) => group.display === 'oncall' && !hasInput(group)),
    menu: section.groups.filter((group) => group.display === 'menu' && !hasInput(group)),
  };
}

/** ラベルに単位を併記する (例: 体温（℃）)。単位が無ければラベルのみ。 */
function labelWithUnit(label: string, unit?: string): string {
  return unit ? `${label}（${unit}）` : label;
}

/**
 * 項目 1 行 (text / number / fraction / select)。rawValue は保存形そのまま
 * (TextEntry/NumericEntry/legacy 文字列/undefined)。書き込みは onWrite (write-through)。
 */
export function ItemRow({
  item,
  rawValue,
  hasLabelCol,
  hasNormalCol,
  freshTapRef,
  onWrite,
}: {
  item: TemplateItem;
  rawValue: unknown;
  hasLabelCol: boolean;
  hasNormalCol: boolean;
  freshTapRef: RefObject<boolean>;
  onWrite: (stored: TextEntry | NumericEntry | '') => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = labelWithUnit(item.label, item.unit);
  const labelCell = hasLabelCol ? (
    <span className="projectionFieldLabel">{item.kind === 'select' ? item.label : label}</span>
  ) : null;
  const normalSpacer = hasNormalCol ? (
    <span className="projectionNormalSpacer" aria-hidden="true" />
  ) : null;

  if (item.kind === 'select') {
    const value = readSelectValue(rawValue, item.options ?? []);
    return (
      <div className="projectionField">
        {labelCell}
        {normalSpacer}
        <div className="tagSelection">
          {(item.options ?? []).map((option) => {
            const selected = value === option;
            return (
              <button
                key={option}
                type="button"
                className={`tagChip${selected ? ' selected' : ''}`}
                aria-pressed={selected}
                data-ui={UI.projection.field}
                onClick={() => {
                  onWrite(manualTextEntry(selected ? '' : option));
                  hapticTick();
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (item.kind === 'text') {
    const value = readTextValue(rawValue);
    const source =
      item.normal !== undefined ? normalizeTextEntry(rawValue, item.normal).source : 'empty';
    const isPreset = source === 'preset';
    return (
      <div className="projectionField">
        {labelCell}
        {item.normal !== undefined ? (
          <NormalCheckButton
            on={isPreset}
            title={
              source === 'empty'
                ? s.detail.normalCheck.input(item.normal)
                : isPreset
                  ? s.detail.normalCheck.clear
                  : s.detail.normalCheck.edit
            }
            ariaLabel={s.detail.normalCheck.aria}
            ariaPressed={isPreset}
            onTrigger={() => {
              // detail 入場直後や対象切替直後のゴーストタップでは書き込まない。
              if (!freshTapRef.current) return;
              const d = decidePresetToggle(rawValue, item.normal);
              if (d.action === 'openEditor') {
                // 手入力を守る: 上書きせず編集へ委ねる。
                inputRef.current?.focus();
                return;
              }
              onWrite(d.action === 'write' ? d.value : '');
              hapticTick();
            }}
          />
        ) : (
          normalSpacer
        )}
        <input
          ref={inputRef}
          className="input"
          type="text"
          value={value}
          aria-label={item.label || item.normal || s.detail.noteInput}
          data-ui={UI.projection.field}
          onChange={(e) => onWrite(manualTextEntry(e.target.value))}
        />
      </div>
    );
  }

  // number / fraction: 値のみの 1 入力 (医療値は `/` や注記が入りうるため type=number にしない)。
  const entry = readNumericEntry(rawValue);
  return (
    <div className="projectionField">
      {labelCell}
      {normalSpacer}
      <input
        className="input"
        type="text"
        inputMode="numeric"
        value={entry.value}
        placeholder={item.kind === 'fraction' ? s.detail.fractionPlaceholder : undefined}
        aria-label={item.label || s.detail.noteInput}
        data-ui={UI.projection.field}
        onChange={(e) => onWrite(numericEntry(e.target.value, entry.note))}
      />
    </div>
  );
}

/** 群 1 つ分の行列 (見出し + 項目行)。値の読み書きは values/onWrite に委ねる。 */
function GroupRows({
  group,
  values,
  freshTapRef,
  onWrite,
}: {
  group: TemplateGroup;
  values: Record<string, unknown>;
  freshTapRef: RefObject<boolean>;
  onWrite: (itemId: string, stored: TextEntry | NumericEntry | '') => void;
}) {
  const hasLabelCol = group.items.some((item) => item.label.trim() !== '');
  const hasNormalCol = group.items.some(
    (item) => item.kind === 'text' && item.normal !== undefined,
  );

  return (
    <>
      {group.name !== '' ? (
        <div className="panelCardHead projectionGroupHead" data-ui={UI.projection.group}>
          <div className="panelLabel">{group.name}</div>
        </div>
      ) : null}
      <div
        className={`projectionRows${hasLabelCol ? ' hasLabel' : ''}${
          hasNormalCol ? ' hasNormal' : ''
        }`}
      >
        {group.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            rawValue={values[item.id]}
            hasLabelCol={hasLabelCol}
            hasNormalCol={hasNormalCol}
            freshTapRef={freshTapRef}
            onWrite={(stored) => onWrite(item.id, stored)}
          />
        ))}
      </div>
    </>
  );
}

/**
 * 呼び出し (oncall/menu) 群の入力シート。保存済み値を draft にし、projectedValues へ保存する。
 */
function OncallGroupSheet({
  group,
  initialValues,
  freshTapRef,
  onSave,
  onClose,
}: {
  group: TemplateGroup;
  initialValues: Record<string, unknown>;
  freshTapRef: RefObject<boolean>;
  onSave: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initialValues }));

  function save(): void {
    if (groupHasInput(values) || groupHasInput(initialValues)) onSave(values);
    onClose();
  }

  return (
    <Modal
      title={group.name || s.detail.noteInput}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.projection.sheet}
      closeLabel={s.common.close}
      footer={
        <Button variant="primary" block dataUi={UI.projection.sheetSave} onClick={save}>
          {s.detail.sheetSave}
        </Button>
      }
    >
      <GroupRows
        group={group}
        values={values}
        freshTapRef={freshTapRef}
        onWrite={(itemId, stored) => setValues((prev) => ({ ...prev, [itemId]: stored }))}
      />
    </Modal>
  );
}

function MenuGroupDialog({
  section,
  groups,
  onSelect,
  onClose,
}: {
  section: TemplateSection;
  groups: TemplateGroup[];
  onSelect: (group: TemplateGroup) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  return (
    <Modal
      title={s.detail.menuTitle(section.title)}
      onClose={onClose}
      variant="dialog"
      dataUi={UI.projection.menuDialog}
      closeLabel={s.common.close}
    >
      <div className="menu-list">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className="menu-item"
            onClick={() => onSelect(group)}
          >
            {group.name || s.detail.noteInput}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function ProjectionFormCard({
  runtime,
  patient,
  freshTapRef,
}: {
  runtime: AppRuntime;
  patient: Patient;
  freshTapRef: RefObject<boolean>;
}) {
  const { store } = runtime;
  const [oncallOpen, setOncallOpen] = useState<TemplateGroup | null>(null);
  const [menuOpen, setMenuOpen] = useState<TemplateSection | null>(null);
  const template: Template | null = store.getActiveTemplate();
  const sections = template?.sections ?? [];
  const pid = patient.pid;
  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  if (sections.length === 0) return null; // テンプレート未選択または場所が無ければ出さない

  function writeValue(
    groupId: string,
    itemId: string,
    stored: TextEntry | NumericEntry | '',
  ): void {
    const p = live();
    if (!p) return;
    const pv = p.projectedValues && typeof p.projectedValues === 'object' ? p.projectedValues : {};
    pv[groupId] = { ...readGroupValues(pv, groupId), [itemId]: stored };
    p.projectedValues = pv;
    store.markUpdated(liveNo());
    store.scheduleSave();
    runtime.bump();
  }

  function saveGroup(groupId: string, values: Record<string, unknown>): void {
    const p = live();
    if (!p) return;
    const pv = p.projectedValues && typeof p.projectedValues === 'object' ? p.projectedValues : {};
    if (groupHasInput(values)) pv[groupId] = { ...values };
    else delete pv[groupId];
    p.projectedValues = pv;
    store.markUpdated(liveNo());
    store.scheduleSave();
    runtime.bump();
  }

  return (
    <section
      className="card panelCard projectionCard"
      aria-label={s.projection.title}
      data-ui={UI.projection.card}
    >
      <div className="panelCardHead">
        <div className="panelLabel">{s.projection.title}</div>
      </div>

      {sections.map((section) => {
        const {
          shown: shownGroups,
          oncall: oncallGroups,
          menu: menuGroups,
        } = partitionSectionGroups(section, patient.projectedValues);
        return (
          <section key={section.id} className="projectionSection" data-ui={UI.projection.section}>
            {/* 見出し無し (title 空) の場所は空の見出しブロックを出さない (合成側の挙動と一致)。 */}
            {section.title !== '' ? <div className="section-label">{section.title}</div> : null}
            {shownGroups.map((group) => (
              <GroupRows
                key={group.id}
                group={group}
                values={readGroupValues(patient.projectedValues, group.id)}
                freshTapRef={freshTapRef}
                onWrite={(itemId, stored) => writeValue(group.id, itemId, stored)}
              />
            ))}
            {oncallGroups.length > 0 ? (
              <div className="tagSelection projectionOncallRow" data-ui={UI.projection.oncall}>
                {oncallGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className="tagChip"
                    onClick={() => {
                      if (!freshTapRef.current) return;
                      setOncallOpen(group);
                    }}
                  >
                    {group.name || s.detail.noteInput}
                  </button>
                ))}
              </div>
            ) : null}
            {menuGroups.length > 0 ? (
              <Button
                dataUi={UI.projection.menu}
                aria-label={s.detail.menuOpen(section.title)}
                onClick={() => {
                  if (!freshTapRef.current) return;
                  setMenuOpen(section);
                }}
              >
                <Icon name="menu" size={18} />
                {s.detail.menuOpen(section.title)}
              </Button>
            ) : null}
          </section>
        );
      })}

      {oncallOpen ? (
        <OncallGroupSheet
          group={oncallOpen}
          initialValues={readGroupValues(patient.projectedValues, oncallOpen.id)}
          freshTapRef={freshTapRef}
          onSave={(values) => saveGroup(oncallOpen.id, values)}
          onClose={() => setOncallOpen(null)}
        />
      ) : null}
      {menuOpen ? (
        <MenuGroupDialog
          section={menuOpen}
          groups={menuOpen.groups.filter((group) =>
            partitionSectionGroups(menuOpen, patient.projectedValues).menu.includes(group),
          )}
          onSelect={(group) => {
            setMenuOpen(null);
            setOncallOpen(group);
          }}
          onClose={() => setMenuOpen(null)}
        />
      ) : null}
    </section>
  );
}
