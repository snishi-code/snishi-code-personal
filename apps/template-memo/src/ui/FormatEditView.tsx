/*
 * フォーマット編集。項目 (ラベル/種類/単位/正常文/選択肢) と合成方法 (joiner/labelSep/titleWrap)、
 * 入力カードに見出しを出すか (showName)
 * を編集する。draft は deep copy し、保存時に normalizeFormat を通す (null なら fail-closed 通知)。
 * 変更は参照する全テンプレートへ即時反映されるため、ヘッダに使用数を表示する。
 */
import { useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import { normalizeFormat, type Format } from '../domain/entities';
import type { ItemKind, TemplateItem } from '../domain/template';
import { errorText, s } from '../i18n';
import { UI } from '../ui-contract';
import type { AppRuntime } from './appRuntime';
import { CheckRow, clone, Field, moveInArray, RowTools } from './EntityEditParts';
import { useRegisterEditor } from './registries';

const ITEM_KINDS: readonly ItemKind[] = ['text', 'select'];

/** 種類を切り替える。種類ごとの専用フィールド (単位/正常文 と 選択肢) は排他的に初期化する。 */
export function morphItemKind(item: TemplateItem, kind: ItemKind): void {
  if (!ITEM_KINDS.includes(kind)) return;
  item.kind = kind;
  delete item.unit;
  delete item.normal;
  delete item.options;
  if (kind === 'select') item.options = [s.tpl.itemOptionDefault];
}

function newItem(): TemplateItem {
  return { id: newId('itm'), label: '', kind: 'text' };
}

export function FormatEditView({
  runtime,
  format,
  onDone,
}: {
  runtime: AppRuntime;
  format: Format;
  onDone: () => void;
}) {
  useRegisterEditor(onDone);
  const toast = useToast();
  const [draft, setDraft] = useState<Format>(() => clone(format));
  const [busy, setBusy] = useState(false);
  const usageCount = runtime.store
    .getTemplateDefs()
    .filter((template) =>
      template.placements.some((placement) => placement.formatId === format.id),
    ).length;

  function mutate(change: (next: Format) => void): void {
    setDraft((current) => {
      const next = clone(current);
      change(next);
      return next;
    });
  }

  function mutateItem(itemId: string, change: (item: TemplateItem) => void): void {
    mutate((next) => {
      const item = next.items.find((candidate) => candidate.id === itemId);
      if (item) change(item);
    });
  }

  async function save(): Promise<void> {
    if (busy) return;
    const normalized = normalizeFormat(draft);
    if (!normalized) {
      toast.show(s.toast.saveFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      await runtime.store.saveFormat(normalized);
      runtime.bump();
      toast.show(s.formatEdit.saved);
      onDone();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderOptions(item: TemplateItem) {
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
              data-ui={UI.formatEdit.option}
              onChange={(event) =>
                mutateItem(item.id, (next) => {
                  (next.options ??= [])[index] = event.target.value;
                })
              }
            />
            <RowTools
              index={index}
              count={options.length}
              disableDelete={options.length === 1}
              onMove={(direction) =>
                mutateItem(item.id, (next) => moveInArray((next.options ??= []), index, direction))
              }
              onDelete={() =>
                mutateItem(item.id, (next) => {
                  next.options = (next.options ?? []).filter((_, i) => i !== index);
                })
              }
            />
          </div>
        ))}
        <Button onClick={() => mutateItem(item.id, (next) => (next.options ??= []).push(''))}>
          {s.tpl.itemOptionAdd}
        </Button>
      </div>
    );
  }

  return (
    <section className="settingsView templateEditView" data-ui={UI.formatEdit.view}>
      <div className="card panelCard">
        <div className="panelLabel">{s.formatEdit.title}</div>
        <p className="muted settingsHint">{s.componentUsage(usageCount)}</p>
        <Field label={s.formatEdit.name}>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => mutate((next) => (next.name = event.target.value))}
          />
        </Field>
        {/* 入力カードの見出しだけを消す。チップ・メニュー・入力シートの名前は残る。 */}
        <CheckRow
          label={s.tpl.formatShowName}
          checked={draft.showName !== false}
          onChange={(checked) =>
            mutate((next) => {
              if (checked) delete next.showName;
              else next.showName = false;
            })
          }
        />
        {/*
          区切りは候補から選ばせず、入れたい文字をそのまま入力させる (改行も入れられるよう textarea)。
          trim すると既定 ', ' の末尾スペースが消え、空文字 (= ラベル区切り「なし」) も作れなくなるため、
          入力値は一切加工せずそのまま保存する。
        */}
        <div className="formatSepBlock">
          <Field label={s.tpl.formatJoiner}>
            <textarea
              className="textarea"
              rows={2}
              value={draft.joiner}
              onChange={(event) => mutate((next) => (next.joiner = event.target.value))}
            />
          </Field>
          <p className="muted settingsHint">{s.tpl.formatSepHint}</p>
        </div>
        <div className="formatSepBlock">
          <Field label={s.tpl.formatLabelSep}>
            <textarea
              className="textarea"
              rows={2}
              value={draft.labelSep}
              onChange={(event) => mutate((next) => (next.labelSep = event.target.value))}
            />
          </Field>
          <p className="muted settingsHint">{s.tpl.formatSepHint}</p>
        </div>
      </div>

      {draft.items.map((item, index) => (
        <div className="templateEditItem" key={item.id} data-ui={UI.formatEdit.item}>
          <div className="formatListRow">
            <span className="pickerRowLabel">
              {s.tpl.items} {index + 1}
            </span>
            <RowTools
              index={index}
              count={draft.items.length}
              // 項目 0 個のフォーマットは normalizeFormat が保存を拒否するため、最後の 1 つは消させない。
              disableDelete={draft.items.length === 1}
              onMove={(direction) => mutate((next) => moveInArray(next.items, index, direction))}
              onDelete={() =>
                mutate((next) => {
                  next.items = next.items.filter((candidate) => candidate.id !== item.id);
                })
              }
            />
          </div>
          <Field label={s.tpl.itemLabel}>
            <input
              className="input"
              value={item.label}
              data-ui={UI.formatEdit.field}
              onChange={(event) => mutateItem(item.id, (next) => (next.label = event.target.value))}
            />
          </Field>
          <div className="settingsField templateEditKindRow">
            <Field label={s.tpl.itemKind}>
              <select
                className="select"
                value={item.kind}
                data-ui={UI.formatEdit.kind}
                onChange={(event) =>
                  mutateItem(item.id, (next) => morphItemKind(next, event.target.value as ItemKind))
                }
              >
                <option value="text">{s.tpl.itemKindText}</option>
                <option value="select">{s.tpl.itemKindSelect}</option>
              </select>
            </Field>
            {item.kind === 'text' ? (
              <Field label={s.tpl.itemUnit}>
                <input
                  className="input"
                  value={item.unit ?? ''}
                  onChange={(event) =>
                    mutateItem(item.id, (next) => (next.unit = event.target.value))
                  }
                />
              </Field>
            ) : null}
          </div>
          {/* 正常文は 1 行が長いので種類の行には並べず、全幅で置く。 */}
          {item.kind === 'text' ? (
            <Field label={s.tpl.itemNormal}>
              <input
                className="input"
                value={item.normal ?? ''}
                onChange={(event) =>
                  mutateItem(item.id, (next) => (next.normal = event.target.value))
                }
              />
            </Field>
          ) : null}
          {item.kind === 'select' ? renderOptions(item) : null}
          <CheckRow
            label={s.tpl.itemShowLabel}
            checked={item.showLabel !== false}
            onChange={(checked) =>
              mutateItem(item.id, (next) => {
                if (checked) delete next.showLabel;
                else next.showLabel = false;
              })
            }
          />
        </div>
      ))}

      <Button onClick={() => mutate((next) => next.items.push(newItem()))}>{s.tpl.itemAdd}</Button>
      <div className="card card--pad settingsRowActions templateEditActions">
        <Button disabled={busy} onClick={onDone}>
          {s.common.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          dataUi={UI.formatEdit.save}
          onClick={() => void save()}
        >
          {s.common.save}
        </Button>
      </div>
    </section>
  );
}
