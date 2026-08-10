/*
 * テンプレート編集 = 配置エディタ。フレーム選択と各場所へのフォーマット配置だけを編集し、
 * 部品の中身はフレーム/フォーマットの編集画面が持つ。draft は deep copy し、保存時に
 * normalizeTemplateDef を通す (null なら durable state に触れず fail-closed 通知)。
 */
import { useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import { normalizeTemplateDef, type FormatPlacement, type TemplateDef } from '../domain/entities';
import type { PlacementDisplay } from '../domain/template';
import { errorText, s } from '../i18n';
import { UI } from '../ui-contract';
import type { AppRuntime } from './appRuntime';
import { CheckRow, clone, Field, RowTools } from './EntityEditParts';
import { useRegisterEditor } from './registries';

const DISPLAYS: readonly PlacementDisplay[] = ['always', 'oncall', 'menu'];

export function TemplateEditView({
  runtime,
  template,
  onDone,
}: {
  runtime: AppRuntime;
  template: TemplateDef;
  onDone: () => void;
}) {
  useRegisterEditor(onDone);
  const toast = useToast();
  const frames = runtime.store.getFrames();
  const formats = runtime.store.getFormats();
  const [draft, setDraft] = useState<TemplateDef>(() => clone(template));
  const [editedAt] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const frame = frames.find((candidate) => candidate.id === draft.frameId) ?? null;

  function mutate(change: (next: TemplateDef) => void): void {
    setDraft((current) => {
      const next = clone(current);
      change(next);
      return next;
    });
  }

  function mutatePlacement(
    placementId: string,
    change: (placement: FormatPlacement) => void,
  ): void {
    mutate((next) => {
      const placement = next.placements.find((candidate) => candidate.id === placementId);
      if (placement) change(placement);
    });
  }

  function changeFrame(frameId: string): void {
    const nextFrame = frames.find((candidate) => candidate.id === frameId);
    if (!nextFrame) return;
    mutate((next) => {
      next.frameId = nextFrame.id;
      next.placements = [];
    });
  }

  function addPlacement(sectionId: string, formatId: string): void {
    if (!formats.some((format) => format.id === formatId)) return;
    mutate((next) => {
      next.placements.push({
        id: newId('plm'),
        sectionId,
        formatId,
        display: 'always',
      });
    });
  }

  function movePlacement(sectionId: string, placementId: string, direction: -1 | 1): void {
    mutate((next) => {
      const sectionPlacements = next.placements.filter(
        (candidate) => candidate.sectionId === sectionId,
      );
      const index = sectionPlacements.findIndex((candidate) => candidate.id === placementId);
      const target = sectionPlacements[index + direction];
      if (index < 0 || !target) return;
      const sourceIndex = next.placements.findIndex((candidate) => candidate.id === placementId);
      const targetIndex = next.placements.findIndex((candidate) => candidate.id === target.id);
      if (sourceIndex < 0 || targetIndex < 0) return;
      [next.placements[sourceIndex], next.placements[targetIndex]] = [
        next.placements[targetIndex]!,
        next.placements[sourceIndex]!,
      ];
    });
  }

  async function save(): Promise<void> {
    if (busy) return;
    const normalized = normalizeTemplateDef({ ...draft, updatedAt: editedAt }, { frames, formats });
    if (!normalized) {
      toast.show(s.toast.saveFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      await runtime.store.saveTemplateDef(normalized);
      runtime.bump();
      toast.show(s.templateEdit.saved);
      onDone();
    } catch (error) {
      toast.show(errorText(error, s.toast.saveFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settingsView templateEditView" data-ui={UI.templateEdit.view}>
      <div className="card panelCard">
        <div className="panelLabel">{s.templateEdit.title}</div>
        <Field label={s.tpl.name}>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => mutate((next) => (next.name = event.target.value))}
          />
        </Field>
        <Field label={s.templateEdit.frame}>
          <select
            className="select"
            value={draft.frameId}
            data-ui={UI.templateEdit.frame}
            onChange={(event) => changeFrame(event.target.value)}
          >
            {frames.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name || s.common.untitled}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted settingsHint">{s.templateEdit.frameChangeHint}</p>
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
      </div>

      {frame?.sections.map((section, sectionIndex) => {
        const placements = draft.placements.filter(
          (candidate) => candidate.sectionId === section.id,
        );
        return (
          <div className="templateEditSection" key={section.id} data-ui={UI.templateEdit.section}>
            <div className="panelLabel">
              {section.title || `${s.tpl.sections} ${sectionIndex + 1}`}
            </div>
            {placements.map((placement, index) => {
              const format = formats.find((candidate) => candidate.id === placement.formatId);
              if (!format) return null;
              return (
                <div
                  className="templateEditPlacement"
                  key={placement.id}
                  data-ui={UI.templateEdit.placement}
                >
                  <div className="formatListRow">
                    <span className="pickerRowLabel" data-ui={UI.templateEdit.placementFormat}>
                      {format.name || s.common.untitled}
                    </span>
                    <RowTools
                      index={index}
                      count={placements.length}
                      deleteLabel={s.templateEdit.removePlacement}
                      onMove={(direction) => movePlacement(section.id, placement.id, direction)}
                      onDelete={() =>
                        mutate((next) => {
                          next.placements = next.placements.filter(
                            (candidate) => candidate.id !== placement.id,
                          );
                        })
                      }
                    />
                  </div>
                  <Field label={s.tpl.placementDisplay}>
                    <select
                      className="select"
                      value={placement.display}
                      data-ui={UI.templateEdit.display}
                      onChange={(event) =>
                        mutatePlacement(
                          placement.id,
                          (next) =>
                            (next.display = DISPLAYS.includes(
                              event.target.value as PlacementDisplay,
                            )
                              ? (event.target.value as PlacementDisplay)
                              : 'always'),
                        )
                      }
                    >
                      <option value="always">{s.tpl.placementDisplayAlways}</option>
                      <option value="oncall">{s.tpl.placementDisplayOncall}</option>
                      <option value="menu">{s.tpl.placementDisplayMenu}</option>
                    </select>
                  </Field>
                </div>
              );
            })}
            <select
              className="select"
              value=""
              aria-label={s.templateEdit.addFormat(section.title)}
              data-ui={UI.templateEdit.addFormat}
              onChange={(event) => {
                const formatId = event.target.value;
                if (formatId) addPlacement(section.id, formatId);
              }}
            >
              <option value="">{s.tpl.formatAdd}</option>
              {formats.map((format) => (
                <option key={format.id} value={format.id}>
                  {format.name || s.common.untitled}
                </option>
              ))}
            </select>
          </div>
        );
      })}

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
