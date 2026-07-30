// 回診入力カード (コピー元: hospital-workspace/rounds/ui/ProjectionFormCard.tsx)。
// 固定フォーム (fixedFields) をテンプレート合成エンジンの群 (TemplateGroup) へ差し替えた。
//
// 仕様:
//   - 表示は現在テンプレートに群がある時だけ (空なら描画しない)。
//   - 常設 (always) 群: 行ごとの入力を patient.projectedValues (FormValues) へ write-through 保存。
//     text 項目は行末に正常文ワンタップボタン (全部正常は群見出し右)。手入力は openEditor で守る。
//   - 呼び出し (oncall) 群: チップからシートを開き、一時値で合成して今回メモへ挿入 (値は保存しない)。
//   - 値の読み書きは必ず domain/formValues.ts のヘルパ経由。
//   - 患者は pid で捕捉する (並び替えで別患者へ書かないため)。MemoCards と同じ write-through。

import { useRef, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { Modal } from '@snishi/foundation/ui/Modal';
import type { Patient, NumericEntry, TextEntry } from '../domain/types';
import {
  decidePresetToggle,
  manualTextEntry,
  normalizeTextEntry,
  numericEntry,
  readGroupValues,
  readNumericEntry,
  readTextValue,
} from '../domain/formValues';
import {
  composeGroup,
  type Template,
  type TemplateGroup,
  type TemplateItem,
} from '../domain/template';
import { appendSnippetToMemo } from '../domain/snippets';
import type { AppRuntime } from './appRuntime';
import { useRegisterOverlay } from './registries';
import { hapticTick } from './feedback';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/** ラベルに単位を併記する (例: 体温（℃）)。単位が無ければラベルのみ。 */
function labelWithUnit(label: string, unit?: string): string {
  return unit ? `${label}（${unit}）` : label;
}

/**
 * 項目 1 行 (text / number / fraction)。rawValue は保存形そのまま
 * (TextEntry/NumericEntry/legacy 文字列/undefined)。書き込みは onWrite (write-through)。
 */
function ItemRow({
  item,
  rawValue,
  onWrite,
}: {
  item: TemplateItem;
  rawValue: unknown;
  onWrite: (stored: TextEntry | NumericEntry | '') => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = labelWithUnit(item.label, item.unit);

  if (item.kind === 'select') {
    const value = readTextValue(rawValue);
    return (
      <div className="projectionField">
        {item.label !== '' ? <span className="projectionFieldLabel">{item.label}</span> : null}
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
    const isPreset =
      item.normal !== undefined && normalizeTextEntry(rawValue, item.normal).source === 'preset';
    return (
      <div className="projectionField">
        {item.label !== '' ? <span className="projectionFieldLabel">{item.label}</span> : null}
        <input
          ref={inputRef}
          className="input"
          type="text"
          value={value}
          aria-label={item.label || item.normal || s.detail.noteInput}
          data-ui={UI.projection.field}
          onChange={(e) => onWrite(manualTextEntry(e.target.value))}
        />
        {item.normal !== undefined ? (
          <Button
            aria-pressed={isPreset}
            onClick={() => {
              const d = decidePresetToggle(rawValue, item.normal);
              if (d.action === 'openEditor') {
                // 手入力を守る: 上書きせず編集へ委ねる。
                inputRef.current?.focus();
                return;
              }
              onWrite(d.action === 'write' ? d.value : '');
              hapticTick();
            }}
          >
            {isPreset ? <Icon name="check" size={16} /> : null}
            {item.normal}
          </Button>
        ) : null}
      </div>
    );
  }

  // number / fraction: 値のみの 1 入力 (医療値は `/` や注記が入りうるため type=number にしない)。
  const entry = readNumericEntry(rawValue);
  return (
    <div className="projectionField">
      {item.label !== '' ? <span className="projectionFieldLabel">{label}</span> : null}
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

/** 群 1 つ分の行列 (見出し + 全部正常 + 項目行)。値の読み書きは values/onWrite に委ねる。 */
function GroupRows({
  group,
  values,
  onWrite,
}: {
  group: TemplateGroup;
  values: Record<string, unknown>;
  onWrite: (itemId: string, stored: TextEntry | NumericEntry | '') => void;
}) {
  const hasNormalText = group.items.some((i) => i.kind === 'text' && i.normal !== undefined);

  // 全部正常: 空の text item だけを正常文 (preset) で埋める。手入力・入力済みは触らない。
  function allNormal(): void {
    for (const item of group.items) {
      if (item.kind !== 'text' || item.normal === undefined) continue;
      if (readTextValue(values[item.id]) !== '') continue;
      onWrite(item.id, { value: item.normal, source: 'preset' } satisfies TextEntry);
    }
    hapticTick();
  }

  return (
    <>
      {group.name !== '' || hasNormalText ? (
        <div className="panelCardHead projectionGroupHead" data-ui={UI.projection.group}>
          <div className="panelLabel">{group.name}</div>
          {hasNormalText ? <Button onClick={allNormal}>{s.detail.allNormal}</Button> : null}
        </div>
      ) : null}
      {group.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          rawValue={values[item.id]}
          onWrite={(stored) => onWrite(item.id, stored)}
        />
      ))}
    </>
  );
}

/**
 * 呼び出し (oncall) 群の入力シート。値は一時 state のみ (保存しない)。
 * 「本文へ挿入」で composeGroup した合成文を今回メモの末尾へ追記する。
 */
function OncallGroupSheet({
  group,
  onInsert,
  onClose,
}: {
  group: TemplateGroup;
  /** 合成文 (hasValue のときだけ呼ばれる)。 */
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const [values, setValues] = useState<Record<string, unknown>>({});

  function insert(): void {
    const { text, hasValue } = composeGroup(group, values);
    if (hasValue) onInsert(text);
    onClose(); // 全項目空なら挿入なしで閉じるだけ (空文を本文へ入れない)
  }

  return (
    <Modal
      title={group.name || s.detail.noteInput}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
      footer={
        <Button variant="primary" block onClick={insert}>
          {s.detail.oncallInsert}
        </Button>
      }
    >
      <GroupRows
        group={group}
        values={values}
        onWrite={(itemId, stored) => setValues((prev) => ({ ...prev, [itemId]: stored }))}
      />
    </Modal>
  );
}

export function ProjectionFormCard({
  runtime,
  patient,
}: {
  runtime: AppRuntime;
  patient: Patient;
}) {
  const { store } = runtime;
  const [oncallOpen, setOncallOpen] = useState<TemplateGroup | null>(null);
  const template: Template | null = store.getActiveTemplate();
  const groups = template ? template.sections.flatMap((sec) => sec.groups) : [];
  const alwaysGroups = groups.filter((g) => g.display === 'always');
  const oncallGroups = groups.filter((g) => g.display === 'oncall');
  const pid = patient.pid;
  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  if (alwaysGroups.length === 0 && oncallGroups.length === 0) return null; // 群が無ければ出さない

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

  function insertOncall(text: string): void {
    const p = live();
    if (!p) return;
    p.visitMemo = appendSnippetToMemo(p.visitMemo, text);
    store.markUpdated(liveNo(), { bumpLight: true });
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

      {/* 常設 (always) 群: patient.projectedValues へ write-through 保存 */}
      {alwaysGroups.map((group) => (
        <GroupRows
          key={group.id}
          group={group}
          values={readGroupValues(patient.projectedValues, group.id)}
          onWrite={(itemId, stored) => writeValue(group.id, itemId, stored)}
        />
      ))}

      {/* 呼び出し (oncall) 群: チップ → シート → 今回メモへ挿入 (値は保存しない) */}
      {oncallGroups.length > 0 ? (
        <div className="tagSelection projectionOncallRow">
          {oncallGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="tagChip"
              onClick={() => setOncallOpen(group)}
            >
              {group.name || s.detail.noteInput}
            </button>
          ))}
        </div>
      ) : null}

      {oncallOpen ? (
        <OncallGroupSheet
          group={oncallOpen}
          onInsert={insertOncall}
          onClose={() => setOncallOpen(null)}
        />
      ) : null}
    </section>
  );
}
