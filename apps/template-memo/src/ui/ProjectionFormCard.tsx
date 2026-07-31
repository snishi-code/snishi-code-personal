// 回診入力カード (コピー元: hospital-workspace/rounds/ui/ProjectionFormCard.tsx)。
// 解決済みテンプレートの配置フォーマットを対象ごとの入力欄へ投影する。
//
// 仕様:
//   - 現在テンプレートの全場所を表示する（フォーマットが無い場所も見出しを残す）。
//   - 展開 (always) 配置: 行ごとの入力を patient.projectedValues へ write-through 保存。
//     text 項目は項目名の右に正常文チェックを置く。手入力は openEditor で守る。
//   - 呼び出し (oncall) / メニュー (menu) 配置: シートの値を同じ projectedValues へ保存。
//   - oncall/menu 配置は値が入ると展開カードへ昇格し、全消去で入口へ戻る。
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
  placementHasInput,
  manualTextEntry,
  normalizeTextEntry,
  numericEntry,
  readPlacementValues,
  readNumericEntry,
  readSelectValue,
  readTextValue,
} from '../domain/formValues';
import type { Template, PlacedFormat, TemplateItem, TemplateSection } from '../domain/template';
import type { AppRuntime } from './appRuntime';
import { useRegisterOverlay } from './registries';
import { hapticTick } from './feedback';
import { s } from '../i18n';
import { UI } from '../ui-contract';
import { NormalCheckButton } from './NormalCheckButton';

export function partitionSectionPlacements(section: TemplateSection, values: FormValues) {
  const hasInput = (placement: PlacedFormat) =>
    placementHasInput(readPlacementValues(values, placement.id));
  return {
    shown: section.formats.filter(
      (placement) => placement.display === 'always' || hasInput(placement),
    ),
    oncall: section.formats.filter(
      (placement) => placement.display === 'oncall' && !hasInput(placement),
    ),
    menu: section.formats.filter(
      (placement) => placement.display === 'menu' && !hasInput(placement),
    ),
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

/** 配置 1 つ分の行列 (見出し + 項目行)。値の読み書きは values/onWrite に委ねる。 */
function PlacementRows({
  placement,
  values,
  freshTapRef,
  onWrite,
}: {
  placement: PlacedFormat;
  values: Record<string, unknown>;
  freshTapRef: RefObject<boolean>;
  onWrite: (itemId: string, stored: TextEntry | NumericEntry | '') => void;
}) {
  const hasLabelCol = placement.items.some((item) => item.label.trim() !== '');
  const hasNormalCol = placement.items.some(
    (item) => item.kind === 'text' && item.normal !== undefined,
  );

  return (
    <>
      {placement.name !== '' ? (
        <div className="panelCardHead projectionPlacementHead" data-ui={UI.projection.placement}>
          <div className="panelLabel">{placement.name}</div>
        </div>
      ) : null}
      <div
        className={`projectionRows${hasLabelCol ? ' hasLabel' : ''}${
          hasNormalCol ? ' hasNormal' : ''
        }`}
      >
        {placement.items.map((item) => (
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
 * 呼び出し (oncall/menu) 配置の入力シート。保存済み値を draft にし、projectedValues へ保存する。
 */
function OncallPlacementSheet({
  placement,
  initialValues,
  freshTapRef,
  onSave,
  onClose,
}: {
  placement: PlacedFormat;
  initialValues: Record<string, unknown>;
  freshTapRef: RefObject<boolean>;
  onSave: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initialValues }));

  function save(): void {
    if (placementHasInput(values) || placementHasInput(initialValues)) onSave(values);
    onClose();
  }

  return (
    <Modal
      title={placement.name || s.detail.noteInput}
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
      <PlacementRows
        placement={placement}
        values={values}
        freshTapRef={freshTapRef}
        onWrite={(itemId, stored) => setValues((prev) => ({ ...prev, [itemId]: stored }))}
      />
    </Modal>
  );
}

function MenuPlacementDialog({
  section,
  formats,
  onSelect,
  onClose,
}: {
  section: TemplateSection;
  formats: PlacedFormat[];
  onSelect: (placement: PlacedFormat) => void;
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
        {formats.map((placement) => (
          <button
            key={placement.id}
            type="button"
            className="menu-item"
            onClick={() => onSelect(placement)}
          >
            {placement.name || s.detail.noteInput}
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
  const [oncallOpen, setOncallOpen] = useState<PlacedFormat | null>(null);
  const [menuOpen, setMenuOpen] = useState<TemplateSection | null>(null);
  const template: Template | null = store.getActiveTemplate();
  const sections = template?.sections ?? [];
  const pid = patient.pid;
  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  if (sections.length === 0) return null; // テンプレート未選択または場所が無ければ出さない

  function writeValue(
    placementId: string,
    itemId: string,
    stored: TextEntry | NumericEntry | '',
  ): void {
    const p = live();
    if (!p) return;
    const pv = p.projectedValues && typeof p.projectedValues === 'object' ? p.projectedValues : {};
    pv[placementId] = {
      ...readPlacementValues(pv, placementId),
      [itemId]: stored,
    };
    p.projectedValues = pv;
    store.markUpdated(liveNo());
    store.scheduleSave();
    runtime.bump();
  }

  function savePlacement(placementId: string, values: Record<string, unknown>): void {
    const p = live();
    if (!p) return;
    const pv = p.projectedValues && typeof p.projectedValues === 'object' ? p.projectedValues : {};
    if (placementHasInput(values)) pv[placementId] = { ...values };
    else delete pv[placementId];
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
          shown: shownPlacements,
          oncall: oncallPlacements,
          menu: menuPlacements,
        } = partitionSectionPlacements(section, patient.projectedValues);
        return (
          <section key={section.id} className="projectionSection" data-ui={UI.projection.section}>
            {/* 見出し無し (title 空) の場所は空の見出しブロックを出さない (合成側の挙動と一致)。 */}
            {section.title !== '' ? <div className="section-label">{section.title}</div> : null}
            {shownPlacements.map((placement) => (
              <PlacementRows
                key={placement.id}
                placement={placement}
                values={readPlacementValues(patient.projectedValues, placement.id)}
                freshTapRef={freshTapRef}
                onWrite={(itemId, stored) => writeValue(placement.id, itemId, stored)}
              />
            ))}
            {oncallPlacements.length > 0 ? (
              <div className="tagSelection projectionOncallRow" data-ui={UI.projection.oncall}>
                {oncallPlacements.map((placement) => (
                  <button
                    key={placement.id}
                    type="button"
                    className="tagChip"
                    onClick={() => {
                      if (!freshTapRef.current) return;
                      setOncallOpen(placement);
                    }}
                  >
                    {placement.name || s.detail.noteInput}
                  </button>
                ))}
              </div>
            ) : null}
            {menuPlacements.length > 0 ? (
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
        <OncallPlacementSheet
          placement={oncallOpen}
          initialValues={readPlacementValues(patient.projectedValues, oncallOpen.id)}
          freshTapRef={freshTapRef}
          onSave={(values) => savePlacement(oncallOpen.id, values)}
          onClose={() => setOncallOpen(null)}
        />
      ) : null}
      {menuOpen ? (
        <MenuPlacementDialog
          section={menuOpen}
          formats={menuOpen.formats.filter((placement) =>
            partitionSectionPlacements(menuOpen, patient.projectedValues).menu.includes(placement),
          )}
          onSelect={(placement) => {
            setMenuOpen(null);
            setOncallOpen(placement);
          }}
          onClose={() => setMenuOpen(null)}
        />
      ) : null}
    </section>
  );
}
