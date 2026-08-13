import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import { buildBuilderPrompt } from '../domain/builderPrompt';
import { planBundleReuse, type FormatReusePlan } from '../domain/entityReuse';
import {
  BUILDER_RESPONSE_MAX_CHARS,
  buildBundleFromCandidate,
  parseBuilderResponse,
  type BuilderCandidate,
  type BuilderParseErrorCode,
  type BuilderWarning,
} from '../domain/templateBuilder';
import { errorText, s } from '../i18n';
import { UI } from '../ui-contract';
import type { AppRuntime } from './appRuntime';
import {
  clearBuilderDraft,
  clearBuilderResponse,
  createBuilderRequest,
  getBuilderDraft,
  newBuilderSource,
  rememberBuilderResponse,
  saveBuilderResponse,
  saveBuilderSources,
  type BuilderSourceDraft,
  type ParsedBuilderDraft,
} from './builderDraft';
import { copyText } from './clipboard';
import { CheckRow } from './EntityEditParts';
import { useRegisterEditor, useRegisterOverlay } from './registries';

const errorStyle: CSSProperties = { color: 'var(--danger)' };

function parseErrorText(code: BuilderParseErrorCode, actualLength: number): string {
  switch (code) {
    case 'empty':
      return s.builder.parseError.empty;
    case 'invalid-json':
      return s.builder.parseError.invalidJson;
    case 'not-object':
      return s.builder.parseError.notObject;
    case 'wrong-kind':
      return s.builder.parseError.wrongKind;
    case 'wrong-version':
      return s.builder.parseError.wrongVersion;
    case 'request-mismatch':
      return s.builder.parseError.requestMismatch;
    case 'truncated':
      return s.builder.parseError.truncated;
    case 'no-sections':
      return s.builder.parseError.noSections;
    case 'too-large':
      return s.builder.parseError.tooLarge(actualLength, BUILDER_RESPONSE_MAX_CHARS);
  }
}

function BuilderSourcesDialog({
  sources,
  onClose,
  onSave,
}: {
  sources: readonly BuilderSourceDraft[];
  onClose: () => void;
  onSave: (sources: BuilderSourceDraft[]) => void;
}) {
  useRegisterOverlay(onClose);
  const [localSources, setLocalSources] = useState<BuilderSourceDraft[]>(() =>
    sources.length > 0 ? sources.map((source) => ({ ...source })) : [newBuilderSource()],
  );

  return (
    <Modal
      title={s.builder.sourcesTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <p className="muted">{s.builder.sourcesIntro}</p>
      <p className="muted">{s.builder.memoryOnly}</p>
      {localSources.map((source, index) => (
        <div className="tm-card" key={source.id}>
          <div className="formatListRow">
            <span className="pickerRowLabel">{s.builder.sourceLabel(index + 1)}</span>
            <IconButton
              label={s.builder.sourceDelete(index + 1)}
              onClick={() =>
                setLocalSources((current) =>
                  current.length === 1
                    ? [{ ...current[0]!, text: '' }]
                    : current.filter((candidate) => candidate.id !== source.id),
                )
              }
            >
              <Icon name="delete" size={18} />
            </IconButton>
          </div>
          <textarea
            className="tm-textarea"
            rows={6}
            value={source.text}
            aria-label={s.builder.sourceLabel(index + 1)}
            placeholder={s.builder.sourcePlaceholder}
            onChange={(event) =>
              setLocalSources((current) =>
                current.map((candidate) =>
                  candidate.id === source.id
                    ? { ...candidate, text: event.target.value }
                    : candidate,
                ),
              )
            }
          />
        </div>
      ))}
      <div className="settingsRowActions">
        <Button onClick={() => setLocalSources((current) => [...current, newBuilderSource()])}>
          {s.builder.sourceAdd}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onSave([]);
            onClose();
          }}
        >
          {s.builder.sourcesClear}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(localSources);
            onClose();
          }}
        >
          {s.builder.sourcesSave}
        </Button>
      </div>
    </Modal>
  );
}

function BuilderPromptDialog({
  prompt,
  onRenew,
  onClose,
}: {
  prompt: string;
  onRenew: () => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const toast = useToast();

  async function copy(): Promise<void> {
    if (await copyText(prompt)) toast.show(s.builder.copied);
    else toast.show(s.builder.copyFailed, 'error');
  }

  return (
    <Modal
      title={s.builder.promptTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <label>
        <span>{s.builder.promptLabel}</span>
        <textarea className="tm-textarea" rows={12} readOnly value={prompt} />
      </label>
      <p style={{ whiteSpace: 'pre-line' }}>{s.builder.promptWarning}</p>
      <div className="settingsRowActions">
        <Button onClick={onRenew}>{s.builder.promptRenew}</Button>
        <Button variant="primary" onClick={() => void copy()}>
          {s.builder.promptCopy}
        </Button>
      </div>
    </Modal>
  );
}

function BuilderResponseDialog({
  requestId,
  initialText,
  onClose,
  onParsed,
  onClear,
}: {
  /** null = 文章の例を編集して依頼文が失効した状態。解析はできず、消すことだけできる。 */
  requestId: string | null;
  initialText: string;
  onClose: () => void;
  onParsed: (parsed: ParsedBuilderDraft) => void;
  onClear: () => void;
}) {
  useRegisterOverlay(onClose);
  const [text, setText] = useState(initialText);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function analyze(): void {
    if (!requestId) return;
    rememberBuilderResponse(text);
    const result = parseBuilderResponse(text, requestId);
    if (!result.ok) {
      setStatus(null);
      setError(parseErrorText(result.code, text.length));
      return;
    }
    const parsed = { candidate: result.candidate, warnings: result.warnings };
    saveBuilderResponse(text, parsed);
    setError(null);
    setStatus(s.builder.responseReady);
    onParsed(parsed);
    onClose();
  }

  return (
    <Modal
      title={s.builder.responseTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <label>
        <span>{s.builder.responseLabel}</span>
        <textarea
          className="tm-textarea"
          rows={12}
          value={text}
          placeholder={s.builder.responsePlaceholder}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            rememberBuilderResponse(event.target.value);
            setStatus(null);
            setError(null);
          }}
        />
      </label>
      <div aria-live="polite">
        {!requestId ? <p className="muted">{s.builder.responseStale}</p> : null}
        {status ? <p>{status}</p> : null}
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="settingsRowActions">
        <Button
          variant="ghost"
          onClick={() => {
            setText('');
            setStatus(null);
            setError(null);
            onClear();
          }}
        >
          {s.builder.responseClear}
        </Button>
        <Button variant="primary" disabled={!requestId || text.trim() === ''} onClick={analyze}>
          {s.builder.responseAnalyze}
        </Button>
      </div>
    </Modal>
  );
}

export function TemplateBuilderSection({
  onPreview,
}: {
  onPreview: (parsed: ParsedBuilderDraft) => void;
}) {
  const [, setRevision] = useState(0);
  const [dialog, setDialog] = useState<'sources' | 'prompt' | 'response' | null>(null);
  const refresh = () => setRevision((current) => current + 1);
  const draft = getBuilderDraft();
  const sourceTexts = draft.sources
    .map((source) => source.text)
    .filter((text) => text.trim() !== '');
  const hasSources = sourceTexts.length > 0;
  const parsedCurrent =
    draft.requestId !== null && draft.parsed?.candidate.requestId === draft.requestId;
  const promptStatus = !hasSources
    ? s.settings.builder.promptUnavailable
    : draft.requestId
      ? s.settings.builder.promptReady
      : s.settings.builder.promptStale;
  const responseStatus = parsedCurrent
    ? s.settings.builder.responseReady
    : draft.responseText
      ? s.settings.builder.responseStale
      : s.settings.builder.responseEmpty;
  const prompt = draft.requestId ? buildBuilderPrompt(sourceTexts, draft.requestId) : '';

  function openPrompt(): void {
    if (!hasSources) return;
    if (!getBuilderDraft().requestId) createBuilderRequest();
    refresh();
    setDialog('prompt');
  }

  return (
    <div className="card card--pad settingsSection" data-ui={UI.settings.builderSection}>
      <div className="section-label">{s.settings.builder.section}</div>
      <p className="muted settingsHint">{s.settings.builder.hint}</p>
      <div className="settingsRowActions">
        <Button
          variant={hasSources ? 'primary' : 'secondary'}
          dataUi={UI.settings.builderSources}
          onClick={() => setDialog('sources')}
        >
          {s.settings.builder.sources} · {s.settings.builder.sourceCount(sourceTexts.length)}
        </Button>
        <Button
          variant={draft.requestId ? 'primary' : 'secondary'}
          dataUi={UI.settings.builderPrompt}
          disabled={!hasSources}
          onClick={openPrompt}
        >
          {s.settings.builder.prompt} · {promptStatus}
        </Button>
        <Button
          variant={parsedCurrent ? 'primary' : 'secondary'}
          dataUi={UI.settings.builderResponse}
          // 依頼文が失効しても、残った「古い返答」を見て消せるように開ける。
          disabled={!draft.requestId && draft.responseText === ''}
          onClick={() => setDialog('response')}
        >
          {s.settings.builder.response} · {responseStatus}
        </Button>
        <Button
          variant={parsedCurrent ? 'primary' : 'secondary'}
          dataUi={UI.settings.builderPreviewOpen}
          disabled={!parsedCurrent}
          onClick={() => {
            const parsed = getBuilderDraft().parsed;
            if (parsed && parsed.candidate.requestId === getBuilderDraft().requestId) {
              onPreview(parsed);
            }
          }}
        >
          {s.settings.builder.preview}
        </Button>
      </div>

      {dialog === 'sources' ? (
        <BuilderSourcesDialog
          sources={draft.sources}
          onClose={() => setDialog(null)}
          onSave={(sources) => {
            saveBuilderSources(sources);
            refresh();
          }}
        />
      ) : null}
      {dialog === 'prompt' && draft.requestId ? (
        <BuilderPromptDialog
          prompt={prompt}
          onClose={() => setDialog(null)}
          onRenew={() => {
            createBuilderRequest();
            refresh();
          }}
        />
      ) : null}
      {dialog === 'response' ? (
        <BuilderResponseDialog
          requestId={draft.requestId}
          initialText={draft.responseText}
          onClose={() => setDialog(null)}
          onParsed={() => refresh()}
          onClear={() => {
            clearBuilderResponse();
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function selectedCandidate(
  candidate: BuilderCandidate,
  selectedFormatKeys: ReadonlySet<string>,
): BuilderCandidate {
  return {
    ...candidate,
    formats: candidate.formats.filter((format) => selectedFormatKeys.has(format.key)),
    template: {
      ...candidate.template,
      placements: candidate.template.placements.filter((placement) =>
        selectedFormatKeys.has(placement.formatKey),
      ),
    },
  };
}

export function TemplateBuilderPreview({
  runtime,
  candidate,
  warnings,
  onDone,
}: {
  runtime: AppRuntime;
  candidate: BuilderCandidate;
  warnings: BuilderWarning[];
  onDone: () => void;
}) {
  useRegisterEditor(onDone);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidate.formats.map((format) => format.key)),
  );
  const [busy, setBusy] = useState(false);
  const sectionName = new Map(
    candidate.frame.sections.map((section) => [section.key, section.title || s.common.untitled]),
  );
  const normalItems = candidate.formats.flatMap((format) =>
    format.items.flatMap((item) =>
      item.normal ? [s.builder.normalItem(format.name, item.label, item.normal)] : [],
    ),
  );

  // 登録時（store.saveGeneratedBundle）と同じ関数で再利用計画を立て、確認画面に明示する。
  // ここで作るバンドルは表示用の使い捨てで、永続化はしない。
  const reuse = useMemo(() => {
    const bundle = (() => {
      try {
        return buildBundleFromCandidate(selectedCandidate(candidate, selected)).bundle;
      } catch {
        return null; // 登録時に同じ例外が出て toast で知らせるので、ここでは注記を出さないだけ。
      }
    })();
    if (!bundle) return null;
    const plan = planBundleReuse(bundle, runtime.store.getFrames(), runtime.store.getFormats());
    // bundle.formats は selectedCandidate.formats と同じ並び。index で候補キーへ戻す。
    const selectedKeys = candidate.formats
      .filter((format) => selected.has(format.key))
      .map((format) => format.key);
    const planByKey = new Map<string, FormatReusePlan>();
    const mergeTargetKey = new Map<FormatReusePlan, string>();
    bundle.formats.forEach((format, index) => {
      const key = selectedKeys[index];
      const entry = plan.formatPlanById.get(format.id);
      if (key === undefined || !entry) return;
      planByKey.set(key, entry);
      if (!mergeTargetKey.has(entry)) mergeTargetKey.set(entry, key);
    });
    return { frame: plan.frame, planByKey, mergeTargetKey };
  }, [candidate, selected, runtime]);

  function reuseNotes(formatKey: string): string[] {
    const entry = reuse?.planByKey.get(formatKey);
    if (!reuse || !entry) return [];
    if (reuse.mergeTargetKey.get(entry) !== formatKey) {
      return [s.builder.reuseMergedInto(entry.candidate.name || s.common.untitled)];
    }
    const notes: string[] = [];
    if (entry.mergedIds.length > 1) notes.push(s.builder.reuseMerged(entry.mergedIds.length));
    if (entry.existing)
      notes.push(s.builder.reuseExisting(entry.existing.name || s.common.untitled));
    return notes;
  }

  async function apply(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const built = buildBundleFromCandidate(selectedCandidate(candidate, selected));
      await runtime.store.saveGeneratedBundle(built.bundle);
      clearBuilderDraft();
      runtime.bump();
      toast.show(s.builder.applied);
      onDone();
    } catch (error) {
      toast.show(errorText(error, s.builder.applyFailed), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settingsView templateEditView" data-ui={UI.settings.builderPreview}>
      <div className="card panelCard">
        <div className="panelLabel">{s.builder.previewTitle}</div>
        <p className="muted settingsHint">{s.builder.previewIntro}</p>
      </div>

      <div className="templateEditSection">
        <h3>{s.builder.frame}</h3>
        <p>{candidate.frame.name}</p>
        {reuse?.frame.existing ? (
          <p className="muted" data-ui={UI.settings.builderReuse}>
            {s.builder.reuseExisting(reuse.frame.existing.name || s.common.untitled)}
          </p>
        ) : null}
        <h3>{s.builder.sections}</h3>
        <ul>
          {candidate.frame.sections.map((section) => (
            <li key={section.key}>
              {section.title || s.common.untitled} ·{' '}
              {section.freeText ? s.builder.sectionFreeText : s.builder.sectionNoFreeText}
            </li>
          ))}
        </ul>
      </div>

      <div className="templateEditSection">
        <h3>{s.builder.formats}</h3>
        {candidate.formats.map((format) => {
          const placements = candidate.template.placements.filter(
            (placement) => placement.formatKey === format.key,
          );
          return (
            <div className="tm-card" key={format.key}>
              <CheckRow
                label={`${format.name} · ${s.builder.formatItems(format.items.length)}`}
                checked={selected.has(format.key)}
                onChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(format.key);
                    else next.delete(format.key);
                    return next;
                  })
                }
              />
              {reuseNotes(format.key).map((note) => (
                <p className="muted" data-ui={UI.settings.builderReuse} key={note}>
                  {note}
                </p>
              ))}
              <p className="muted">
                {s.builder.placements}:{' '}
                {placements.length > 0
                  ? placements
                      .map((placement) =>
                        s.builder.placement(
                          sectionName.get(placement.sectionKey) ?? placement.sectionKey,
                          placement.display === 'oncall'
                            ? s.builder.displayOncall
                            : s.builder.displayAlways,
                        ),
                      )
                      .join(' / ')
                  : s.builder.noPlacement}
              </p>
            </div>
          );
        })}
      </div>

      <div className="templateEditSection">
        <h3>{s.builder.normals}</h3>
        <p>{s.builder.normalWarning}</p>
        {normalItems.length > 0 ? (
          <ul>
            {normalItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{s.builder.noNormals}</p>
        )}
      </div>

      <div className="templateEditSection">
        <h3>{s.builder.dropped(warnings.length)}</h3>
        {warnings.length > 0 ? (
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.code}:${index}`}>{warning.message}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{s.builder.noDropped}</p>
        )}
        <h3>{s.builder.aiWarnings}</h3>
        {candidate.aiWarnings.length > 0 ? (
          <ul>
            {candidate.aiWarnings.map((warning, index) => (
              <li key={`${warning}:${index}`}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{s.builder.noAiWarnings}</p>
        )}
      </div>

      <div className="card card--pad settingsRowActions templateEditActions">
        <Button disabled={busy} onClick={onDone}>
          {s.builder.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          dataUi={UI.settings.builderApply}
          onClick={() => void apply()}
        >
          {s.builder.apply}
        </Button>
      </div>
    </section>
  );
}
