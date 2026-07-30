/*
 * テンプレート QR 送信ダイアログ。
 *
 * domain/templateWire が作った TPL/C1 ページだけを表示する。対象データを受け取る
 * props 自体を持たず、wire authority 側でも Template の既知フィールドへ射影する。
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { drawQrToCanvas } from '@snishi/foundation/qr/render';
import { useAutoPager } from '@snishi/foundation/qr/useAutoPager';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useWakeLock } from '@snishi/foundation/ui/useWakeLock';
import type { Template } from '../domain/template';
import { encodeTemplateWirePages, TemplateWireError } from '../domain/templateWire';
import { s } from '../i18n';

const AUTO_ADVANCE_MS = 900;

function encodeErrorMessage(error: unknown): string {
  if (error instanceof TemplateWireError) {
    if (error.code === 'compression-required') return s.templateQr.errorCompression;
    if (error.code === 'invalid-template') return s.templateQr.errorTemplate;
  }
  return s.templateQr.errorEncode;
}

const errorStyle: CSSProperties = { color: 'var(--danger)' };
const toggleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
};

export interface TemplateQrSendDialogProps {
  template: Template;
  onClose: () => void;
}

type EncodeState =
  | { source: Template; status: 'preparing' }
  | { source: Template; status: 'ready'; pages: string[] }
  | { source: Template; status: 'error'; message: string };

export function TemplateQrSendDialog({ template, onClose }: TemplateQrSendDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [encodeState, setEncodeState] = useState<EncodeState>({
    source: template,
    status: 'preparing',
  });
  const [drawError, setDrawError] = useState<string | null>(null);
  const activeEncodeState: EncodeState =
    encodeState.source === template ? encodeState : { source: template, status: 'preparing' };
  const pages = activeEncodeState.status === 'ready' ? activeEncodeState.pages : [];
  const encodeError = activeEncodeState.status === 'error' ? activeEncodeState.message : null;
  const preparing = activeEncodeState.status === 'preparing';

  const pager = useAutoPager(pages.length, {
    intervalMs: AUTO_ADVANCE_MS,
    active: pages.length > 1,
    initialPlaying: true,
  });
  const currentPage = pages[pager.index] ?? '';

  useWakeLock(pages.length > 0);

  useEffect(() => {
    let cancelled = false;
    void encodeTemplateWirePages(template)
      .then((nextPages) => {
        if (!cancelled) {
          setEncodeState({ source: template, status: 'ready', pages: nextPages });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setEncodeState({
            source: template,
            status: 'error',
            message: encodeErrorMessage(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [template]);

  useEffect(() => {
    if (currentPage === '') return;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        drawQrToCanvas(currentPage, canvas);
        setDrawError(null);
      } catch (error) {
        console.error('template qr draw failed', error);
        setDrawError(s.templateQr.errorDraw);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [currentPage]);

  return (
    <Modal
      title={s.templateQr.sendTitle}
      onClose={onClose}
      variant="dialog"
      closeLabel={s.common.close}
    >
      <p>
        <strong>{template.name}</strong>
      </p>
      <p className="muted">{s.templateQr.sendHint}</p>

      {preparing ? <p>{s.common.loading}</p> : null}
      {encodeError !== null ? (
        <p role="alert" style={errorStyle}>
          {encodeError}
        </p>
      ) : null}

      {!preparing && encodeError === null && pages.length > 0 ? (
        <>
          <div
            className="tm-qr-canvas-wrap"
            style={drawError === null ? undefined : { display: 'none' }}
          >
            <canvas ref={canvasRef} />
          </div>
          {drawError !== null ? (
            <p role="alert" style={errorStyle}>
              {drawError}
            </p>
          ) : null}

          <div className="toolbar" style={{ alignItems: 'center', marginBottom: 0 }}>
            <span className="muted">{s.qr.page(pager.index + 1, pages.length)}</span>
            {pages.length > 1 ? (
              <>
                <IconButton
                  label={s.templateQr.previousPage}
                  onClick={pager.prev}
                  disabled={pager.index <= 0}
                  style={{ marginLeft: 'auto' }}
                >
                  <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
                    <Icon name="chevronRight" size={20} />
                  </span>
                </IconButton>
                <IconButton
                  label={s.templateQr.nextPage}
                  onClick={pager.next}
                  disabled={pager.index >= pages.length - 1}
                >
                  <Icon name="chevronRight" size={20} />
                </IconButton>
              </>
            ) : null}
          </div>

          {pages.length > 1 ? (
            <label style={toggleRowStyle}>
              <input
                type="checkbox"
                checked={pager.playing}
                onChange={pager.toggle}
                style={{ width: 20, height: 20 }}
              />
              {s.qr.autoPage}
            </label>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
