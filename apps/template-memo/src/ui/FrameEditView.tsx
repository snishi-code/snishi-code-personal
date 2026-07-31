/*
 * フレーム編集。場所 (見出し/正常文/自由本文欄) の並びを編集する。draft は deep copy し、
 * 保存時に normalizeFrame を通す (null なら fail-closed 通知)。参照テンプレートへ即時反映。
 */
import { useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import { normalizeFrame, type Frame, type FrameSection } from '../domain/entities';
import { errorText, s } from '../i18n';
import { UI } from '../ui-contract';
import type { AppRuntime } from './appRuntime';
import { CheckRow, clone, Field, moveInArray, RowTools } from './EntityEditParts';
import { useRegisterEditor } from './registries';

function newSection(): FrameSection {
  return { id: newId('sec'), title: '', freeText: true };
}

export function FrameEditView({
  runtime,
  frame,
  onDone,
}: {
  runtime: AppRuntime;
  frame: Frame;
  onDone: () => void;
}) {
  useRegisterEditor(onDone);
  const toast = useToast();
  const [draft, setDraft] = useState<Frame>(() => clone(frame));
  const [busy, setBusy] = useState(false);
  const usageCount = runtime.store
    .getTemplateDefs()
    .filter((template) => template.frameId === frame.id).length;

  function mutate(change: (next: Frame) => void): void {
    setDraft((current) => {
      const next = clone(current);
      change(next);
      return next;
    });
  }

  function mutateSection(sectionId: string, change: (section: FrameSection) => void): void {
    mutate((next) => {
      const section = next.sections.find((candidate) => candidate.id === sectionId);
      if (section) change(section);
    });
  }

  async function save(): Promise<void> {
    if (busy) return;
    const normalized = normalizeFrame(draft);
    if (!normalized) {
      toast.show(s.toast.saveFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      await runtime.store.saveFrame(normalized);
      runtime.bump();
      toast.show(s.frameEdit.saved);
      onDone();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settingsView templateEditView" data-ui={UI.frameEdit.view}>
      <div className="card panelCard">
        <div className="panelLabel">{s.frameEdit.title}</div>
        <p className="muted settingsHint">{s.componentUsage(usageCount)}</p>
        <Field label={s.frameEdit.name}>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => mutate((next) => (next.name = event.target.value))}
          />
        </Field>
      </div>

      {draft.sections.map((section, index) => (
        <div className="templateEditSection" key={section.id} data-ui={UI.frameEdit.section}>
          <div className="formatListRow">
            <span className="pickerRowLabel">
              {s.tpl.sections} {index + 1}
            </span>
            <RowTools
              index={index}
              count={draft.sections.length}
              disableDelete={draft.sections.length === 1}
              onMove={(direction) => mutate((next) => moveInArray(next.sections, index, direction))}
              onDelete={() =>
                mutate((next) => {
                  next.sections = next.sections.filter((candidate) => candidate.id !== section.id);
                })
              }
            />
          </div>
          <Field label={s.tpl.sectionTitle}>
            <input
              className="input"
              value={section.title}
              data-ui={UI.frameEdit.field}
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
                mutateSection(section.id, (next) => {
                  const value = event.target.value;
                  if (value === '') delete next.normal;
                  else next.normal = value;
                })
              }
            />
          </Field>
          <CheckRow
            label={s.tpl.sectionFreeText}
            checked={section.freeText}
            onChange={(checked) => mutateSection(section.id, (next) => (next.freeText = checked))}
          />
        </div>
      ))}

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
          dataUi={UI.frameEdit.save}
          onClick={() => void save()}
        >
          {s.common.save}
        </Button>
      </div>
    </section>
  );
}
