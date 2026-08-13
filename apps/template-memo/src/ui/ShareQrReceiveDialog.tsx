import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { isScannerSupported, scanQrStream, type ScanSession } from '@snishi/foundation/qr/scan';
import { Button } from '@snishi/foundation/ui/Button';
import { Modal } from '@snishi/foundation/ui/Modal';
import {
  createShareWireCollector,
  FORMAT_WIRE_KIND,
  FRAME_WIRE_KIND,
  prepareShareImport,
  TemplateWireError,
  type ExistingShareEntities,
  type ShareWirePayload,
  type ShareWireReceiveResult,
} from '../domain/templateWire';
import { s } from '../i18n';

const errorStyle: CSSProperties = { color: 'var(--danger)' };
const videoStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  maxHeight: '40dvh',
  borderRadius: 8,
  background: '#000000',
  objectFit: 'cover',
};
const previewGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(8rem, auto) 1fr',
  gap: '8px 12px',
  margin: '12px 0',
};

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
    case 'invalid-frame':
    case 'invalid-format':
      return s.templateQr.errorEntity;
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

function Preview({ payload }: { payload: ShareWirePayload }) {
  if (payload.kind === FRAME_WIRE_KIND) {
    return (
      <dl style={previewGridStyle}>
        <dt>{s.templateQr.kind}</dt>
        <dd>{s.templateQr.frame}</dd>
        <dt>{s.frameEdit.name}</dt>
        <dd>{payload.frame.name}</dd>
        <dt>{s.tpl.sections}</dt>
        <dd>{payload.frame.sections.length}</dd>
      </dl>
    );
  }
  if (payload.kind === FORMAT_WIRE_KIND) {
    return (
      <dl style={previewGridStyle}>
        <dt>{s.templateQr.kind}</dt>
        <dd>{s.templateQr.format}</dd>
        <dt>{s.formatEdit.name}</dt>
        <dd>{payload.format.name}</dd>
        <dt>{s.tpl.items}</dt>
        <dd>{payload.format.items.length}</dd>
      </dl>
    );
  }
  return (
    <dl style={previewGridStyle}>
      <dt>{s.templateQr.kind}</dt>
      <dd>{s.templateQr.templatePackage}</dd>
      <dt>{s.tpl.name}</dt>
      <dd>{payload.package.template.name}</dd>
      <dt>{s.templateQr.frame}</dt>
      <dd>
        {payload.package.frame.name}（{payload.package.frame.sections.length}場所）
      </dd>
      <dt>{s.templateQr.formats}</dt>
      <dd>
        {payload.package.formats.length > 0
          ? payload.package.formats.map((format) => format.name).join('、')
          : s.templateQr.none}
      </dd>
    </dl>
  );
}

export function ShareQrReceiveDialog({
  existing,
  onSave,
  onClose,
  onSaved,
}: {
  existing: ExistingShareEntities;
  onSave: (payload: ShareWirePayload) => Promise<void>;
  onClose: () => void;
  onSaved?: (payload: ShareWirePayload) => void;
}) {
  const collectorRef = useRef(createShareWireCollector());
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanSessionRef = useRef<ScanSession | null>(null);
  const scanProcessingRef = useRef(false);
  const [cameraSupported] = useState(() => isScannerSupported());
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pastedPage, setPastedPage] = useState('');
  const [receiveStatus, setReceiveStatus] = useState<string | null>(null);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ShareWirePayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    scanSessionRef.current?.stop();
    scanSessionRef.current = null;
    setCameraActive(false);
  }, []);
  useEffect(() => () => scanSessionRef.current?.stop(), []);

  const applyReceiveResult = useCallback(
    (result: ShareWireReceiveResult) => {
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
      if (!('payload' in result)) return;
      setReceiveStatus(s.templateQr.progress(result.got, result.total));
      setPreview(result.payload);
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
    setSaveError(null);
  }, [stopCamera]);

  const applyPayload = useCallback(async () => {
    if (!preview || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const imported = prepareShareImport(preview, existing);
      await onSave(imported);
      onSaved?.(imported);
      onClose();
    } catch (error) {
      console.error('share qr save failed', error);
      setSaveError(s.templateQr.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [existing, onClose, onSave, onSaved, preview, saving]);

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

      {preview !== null ? (
        <>
          <h3>{s.templateQr.previewTitle}</h3>
          <Preview payload={preview} />
          <p className="muted">{s.templateQr.collisionSafety}</p>
          {saveError !== null ? (
            <p role="alert" style={errorStyle}>
              {saveError}
            </p>
          ) : null}
          <div className="toolbar">
            <Button variant="ghost" onClick={resetReceive} disabled={saving}>
              {s.templateQr.reset}
            </Button>
            <Button variant="primary" onClick={() => void applyPayload()} disabled={saving}>
              {saving ? s.common.loading : s.common.save}
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
