// 回診入力カード (コピー元: hospital-workspace/rounds/ui/ProjectionFormCard.tsx)。
// 解決済みテンプレートの配置フォーマットを対象ごとの入力欄へ投影する。
//
// 仕様:
//   - 現在テンプレートの全場所を表示する（フォーマットが無い場所も見出しを残す）。
//   - 展開 (always) 配置: 行ごとの入力を patient.projectedValues へ write-through 保存。
//     text 項目は項目名の右に正常文チェックを置く。手入力は openEditor で守る。
//   - フォーマット名の見出しは Format.showName === false で配置ごとに消せる (縦を詰めるため)。
//     入力シートの中では Modal title が名前を出すので、見出しは常に描かない (二重表示の解消)。
//   - 呼び出し (oncall) / メニュー (menu) 配置: シートの値を同じ projectedValues へ保存。
//   - oncall/menu 配置は値が入ると展開カードへ昇格し、全消去で入口へ戻る。
//   - freeText の場所には自由入力欄 (textarea) を出し、patient.sectionTexts[場所id] へ
//     write-through 保存する (今回分。ラウンド開始でクリアされる)。
//   - 場所 (section) ごとに見出し・展開カード・呼び出しチップ・メニュー・自由入力欄をまとめる。
//   - 値の読み書きは必ず domain/formValues.ts のヘルパ経由。
//   - 患者は pid で捕捉する (並び替えで別患者へ書かないため)。MemoCards と同じ write-through。

import { useRef, useState, type RefObject } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from '@snishi/foundation/ui/Modal';
import type { FormValues, Patient, TextEntry } from '../domain/types';
import {
  decidePresetToggle,
  placementHasInput,
  manualTextEntry,
  normalizeTextEntry,
  readEntryNote,
  readPlacementValues,
  readSelectValue,
  readTextValue,
} from '../domain/formValues';
import type { Template, PlacedFormat, TemplateItem, TemplateSection } from '../domain/template';
import type { AppRuntime } from './appRuntime';
import { useRegisterOverlay } from './registries';
import { autosize } from './MemoCards';
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
 * 項目 1 行 (text / select)。rawValue は保存形そのまま
 * (TextEntry / 旧 number・fraction の { value, note? } / legacy 文字列 / undefined)。
 * 書き込みは onWrite (write-through)。
 *
 * text の入力欄には inputMode を与えない。文字種を狭めても打てない文字が生まれるだけで
 * (iOS の数字キーパッドには "." も "/" も無く、36.5 や 120/80 が入力不能になる)、
 * 端末の通常キーボードなら数字も記号も同じ場所から打てるため。
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
  onWrite: (stored: TextEntry | '') => void;
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

  const value = readTextValue(rawValue);
  // 旧 number/fraction 由来の注記は入力 UI が無い。編集で黙って捨てないよう書き戻す。
  const note = readEntryNote(rawValue);
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
        aria-label={label || item.normal || s.detail.noteInput}
        data-ui={UI.projection.field}
        onChange={(e) => onWrite(manualTextEntry(e.target.value, note))}
      />
    </div>
  );
}

/** 配置 1 つ分の行列 (見出し + 項目行)。値の読み書きは values/onWrite に委ねる。 */
export function PlacementRows({
  placement,
  values,
  freshTapRef,
  showHead = true,
  onWrite,
}: {
  placement: PlacedFormat;
  values: Record<string, unknown>;
  freshTapRef: RefObject<boolean>;
  showHead?: boolean;
  onWrite: (itemId: string, stored: TextEntry | '') => void;
}) {
  const hasLabelCol = placement.items.some((item) => item.label.trim() !== '');
  const hasNormalCol = placement.items.some(
    (item) => item.kind === 'text' && item.normal !== undefined,
  );
  // 見出しを出す条件:
  //   showHead    シートの中では常に false (Modal title が名前を出すので二重になる)
  //   showName    フォーマット側の設定 (false = 出さない)
  //   hasLabelCol ラベル列を持たない配置では showName に関わらず出す。項目ラベルも
  //               フォーマット名も無いと、匿名の入力枠が並ぶだけで特定できなくなるため。
  const headVisible =
    showHead && placement.name !== '' && (placement.showName !== false || !hasLabelCol);

  return (
    <>
      {headVisible ? (
        <div className="panelCardHead projectionPlacementHead" data-ui={UI.projection.placement}>
          <div className="panelLabel">{placement.name}</div>
        </div>
      ) : null}
      <div
        className={`projectionRows${hasLabelCol ? ' hasLabel' : ''}${
          hasNormalCol ? ' hasNormal' : ''
        }${headVisible ? '' : ' noHead'}`}
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
        showHead={false}
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

  function writeValue(placementId: string, itemId: string, stored: TextEntry | ''): void {
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

  /** 場所ごとの自由本文。空になったら key ごと落とす (空値レコードを残さない)。 */
  function writeSectionText(sectionId: string, text: string): void {
    const p = live();
    if (!p) return;
    const texts = p.sectionTexts && typeof p.sectionTexts === 'object' ? p.sectionTexts : {};
    if (text === '') delete texts[sectionId];
    else texts[sectionId] = text;
    p.sectionTexts = texts;
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

      {sections.map((section, sectionIndex) => {
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
            {/* 自由入力欄は場所の末尾 (合成順 = 配置 → 自由本文 に合わせる)。
                key に pid を含め、対象切替で必ず再マウントする (前対象の入力を持ち越さない)。 */}
            {section.freeText ? (
              <textarea
                key={`${patient.pid}:${section.id}`}
                className="textarea memoInput projectionFreeText"
                rows={2}
                value={String(patient.sectionTexts?.[section.id] ?? '')}
                aria-label={section.title || s.projection.freeTextAria(sectionIndex + 1)}
                data-ui={UI.projection.freeText}
                onFocus={(e) => autosize(e.currentTarget)}
                onChange={(e) => {
                  writeSectionText(section.id, e.target.value);
                  autosize(e.currentTarget);
                }}
              />
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
