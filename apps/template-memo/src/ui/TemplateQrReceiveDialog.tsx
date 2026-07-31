/*
 * テンプレート QR 受信ダイアログ。
 *
 * TPL ページを順不同で収集し、全ページの C1/JSON/Template 検証が終わるまで
 * store へは一切書かない。完成後も必ず内容をプレビューし、同一 id がある時は
 * 上書きか新 id での追加を人間が選んでから saveTemplate() する。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { uniqueName } from '@snishi/foundation/qr/protocol';
import { isScannerSupported, scanQrStream, type ScanSession } from '@snishi/foundation/qr/scan';
import { Button } from '@snishi/foundation/ui/Button';
import { Modal } from '@snishi/foundation/ui/Modal';
import { newId } from '../data/constants';
import type { Template } from '../domain/template';
import {
  createTemplateWireCollector,
  summarizeTemplate,
  TemplateWireError,
  type TemplateWireReceiveResult,
} from '../domain/templateWire';
import { s } from '../i18n';

function decodeErrorMessage(error: unknown): string {
  if (!(error instanceof TemplateWireError)) return s.templateQr.errorDecode;
  switch (error.code) {
    case 'invalid-transport':
    case 'compression-required':
      return s.templateQr.errorTransport;
    case 'invalid-json':
      return s.templateQr.errorJson;
    case 'wrong-version':
      return s.templateQr.errorVersion;
    case 'invalid-template':
      return s.templateQr.errorTemplate;
    case 'incomplete-pages':
    case 'mixed-batch':
      return s.templateQr.errorIncomplete;
    case 'invalid-page':
    case 'wrong-kind':
      return s.templateQr.invalidPage;
    default:
      return s.templateQr.errorDecode;
  }
}

const errorStyle: CSSProperties = { color: 'var(--danger)' };
const videoStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  maxHeight: '40dvh',
  borderRadius: 8,
  background: '#000000',
  objectFit: 'cover',
};
const radioRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
};
const previewGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(8rem, auto) 1fr',
  gap: '8px 12px',
  margin: '12px 0',
};

type SaveMode = 'overwrite' | 'copy';

export interface TemplateQrReceiveDialogProps {
  /** 既存テンプレート一覧 (id 衝突判定・重複名回避に使う)。 */
  templates: Template[];
  /** 保存 (store.saveTemplate へ委譲)。 */
  onSave: (template: Template) => Promise<void>;
  onClose: () => void;
  /** 保存成功時だけ呼ぶ。toast 等は統合側が担う。 */
  onSaved?: (template: Template) => void;
}

export function TemplateQrReceiveDialog({
  templates,
  onSave,
  onClose,
  onSaved,
}: TemplateQrReceiveDialogProps) {
  const collectorRef = useRef(createTemplateWireCollector());
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanSessionRef = useRef<ScanSession | null>(null);
  const scanProcessingRef = useRef(false);

  const [cameraSupported] = useState(() => isScannerSupported());
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pastedPage, setPastedPage] = useState('');
  const [receiveStatus, setReceiveStatus] = useState<string | null>(null);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Template | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>('copy');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    scanSessionRef.current?.stop();
    scanSessionRef.current = null;
    setCameraActive(false);
  }, []);

  useEffect(() => () => scanSessionRef.current?.stop(), []);

  const applyReceiveResult = useCallback(
    (result: TemplateWireReceiveResult) => {
      if (result.status === 'rejected') {
        setReceiveError(
          result.reason === 'wrong-kind'
            ? s.templateQr.wrongKind(result.gotKind ?? '?')
            : s.templateQr.invalidPage,
        );
        return;
      }

      setReceiveError(null);
      if (result.status === 'duplicate') {
        setReceiveStatus(s.templateQr.duplicate(result.got, result.total));
        return;
      }
      if (result.status === 'progress') {
        setReceiveStatus(s.templateQr.progress(result.got, result.total));
        return;
      }
      if (!('template' in result)) return;

      setReceiveStatus(s.templateQr.progress(result.got, result.total));
      setPreview(result.template);
      setSaveMode('copy');
      setSaveError(null);
      stopCamera();
    },
    [stopCamera],
  );

  const receivePage = useCallback(
    async (text: string, source: 'camera' | 'paste') => {
      try {
        const result = await collectorRef.current.receivePage(text);
        applyReceiveResult(result);
        // fail-closed: 形式/kind 不一致や decode throw では貼り付け欄を残す。
        if (source === 'paste' && result.consumed) setPastedPage('');
      } catch (error) {
        setReceiveError(decodeErrorMessage(error));
      }
    },
    [applyReceiveResult],
  );

  const startCamera = useCallback(() => {
    if (!cameraSupported || scanSessionRef.current) return;
    const video = videoRef.current;
    if (!video) return;

    setCameraError(null);
    setCameraActive(true);
    scanSessionRef.current = scanQrStream(
      video,
      (text) => {
        if (scanProcessingRef.current) return false;
        scanProcessingRef.current = true;
        void receivePage(text, 'camera').finally(() => {
          scanProcessingRef.current = false;
        });
        return false;
      },
      {
        onError: () => {
          scanSessionRef.current = null;
          setCameraActive(false);
          setCameraError(s.templateQr.cameraFailed);
        },
      },
    );
  }, [cameraSupported, receivePage]);

  const resetReceive = useCallback(() => {
    stopCamera();
    collectorRef.current.reset();
    setPastedPage('');
    setReceiveStatus(null);
    setReceiveError(null);
    setPreview(null);
    setSaveMode('copy');
    setSaveError(null);
  }, [stopCamera]);

  const collision = preview ? templates.some((template) => template.id === preview.id) : false;
  const summary = preview ? summarizeTemplate(preview) : null;

  const applyTemplate = useCallback(async () => {
    if (!preview || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      let toSave = preview;
      const idExists = templates.some((template) => template.id === preview.id);
      if (idExists && saveMode === 'copy') {
        toSave = {
          ...preview,
          id: newId('tpl'),
          name: uniqueName(
            preview.name,
            templates.map((template) => template.name),
          ),
          updatedAt: Date.now(),
        };
      }
      await onSave(toSave);
      onSaved?.(toSave);
      onClose();
    } catch (error) {
      console.error('template qr save failed', error);
      setSaveError(s.templateQr.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [onClose, onSave, onSaved, preview, saveMode, saving, templates]);

  return (
    <Modal
      title={s.templateQr.receiveTitle}
      onClose={saving ? () => undefined : onClose}
      variant="dialog"
      closeLabel={s.common.close}
      dismissMode={saving ? 'never' : 'always'}
    >
      <p className="muted">{s.templateQr.receiveIntro}</p>

      {preview === null ? (
        <>
          {cameraSupported ? (
            <section className="tm-card">
              <video
                ref={videoRef}
                muted
                playsInline
                aria-label={s.templateQr.cameraLabel}
                style={cameraActive ? videoStyle : { ...videoStyle, display: 'none' }}
              />
              <Button
                block
                variant={cameraActive ? 'secondary' : 'primary'}
                onClick={cameraActive ? stopCamera : startCamera}
              >
                {cameraActive ? s.templateQr.cameraStop : s.templateQr.cameraStart}
              </Button>
              {cameraError !== null ? (
                <p role="alert" style={errorStyle}>
                  {cameraError}
                </p>
              ) : null}
            </section>
          ) : (
            <p className="muted">{s.templateQr.cameraUnavailable}</p>
          )}

          <section className="tm-card">
            <label>
              <span>{s.templateQr.pasteLabel}</span>
              <textarea
                className="tm-textarea"
                value={pastedPage}
                onChange={(event) => setPastedPage(event.target.value)}
                placeholder={s.templateQr.pastePlaceholder}
                spellCheck={false}
              />
            </label>
            <Button
              block
              onClick={() => void receivePage(pastedPage, 'paste')}
              disabled={pastedPage.trim() === ''}
            >
              {s.templateQr.readPage}
            </Button>
          </section>

          <div aria-live="polite">
            {receiveStatus !== null ? <p>{receiveStatus}</p> : null}
            {receiveError !== null ? (
              <p role="alert" style={errorStyle}>
                {receiveError}
              </p>
            ) : null}
          </div>
          {receiveStatus !== null || receiveError !== null ? (
            <Button block variant="ghost" onClick={resetReceive}>
              {s.templateQr.reset}
            </Button>
          ) : null}
        </>
      ) : null}

      {preview !== null && summary !== null ? (
        <>
          <h3>{s.templateQr.previewTitle}</h3>
          <dl style={previewGridStyle}>
            <dt>{s.tpl.name}</dt>
            <dd>{preview.name}</dd>
            <dt>{s.tpl.sections}</dt>
            <dd>{s.templateQr.counts(summary.sections, summary.formats, summary.items)}</dd>
            <dt>{s.tpl.includeProblems}</dt>
            <dd>{preview.includeProblems ? s.templateQr.included : s.templateQr.excluded}</dd>
            <dt>{s.tpl.includeHandover}</dt>
            <dd>{preview.includeHandover ? s.templateQr.included : s.templateQr.excluded}</dd>
          </dl>

          {collision ? (
            <fieldset className="tm-card">
              <legend>{s.templateQr.conflictTitle}</legend>
              <p className="muted">{s.templateQr.conflictBody}</p>
              <label style={radioRowStyle}>
                <input
                  type="radio"
                  name="template-qr-save-mode"
                  value="overwrite"
                  checked={saveMode === 'overwrite'}
                  onChange={() => setSaveMode('overwrite')}
                />
                {s.templateQr.overwrite}
              </label>
              <label style={radioRowStyle}>
                <input
                  type="radio"
                  name="template-qr-save-mode"
                  value="copy"
                  checked={saveMode === 'copy'}
                  onChange={() => setSaveMode('copy')}
                />
                {s.templateQr.addCopy}
              </label>
            </fieldset>
          ) : null}

          {saveError !== null ? (
            <p role="alert" style={errorStyle}>
              {saveError}
            </p>
          ) : null}
          <div className="toolbar">
            <Button variant="ghost" onClick={resetReceive} disabled={saving}>
              {s.templateQr.reset}
            </Button>
            <Button variant="primary" onClick={() => void applyTemplate()} disabled={saving}>
              {saving ? s.common.loading : s.common.save}
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
