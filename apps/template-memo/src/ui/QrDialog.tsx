/*
 * QR 表示ダイアログ。清書テキスト（改行変換後）を buildQrPages で 600B/ページに分割し、
 * 1 ページずつ canvas へ描画する。medical 側 hospital-workspace の TextQrDialog を
 * template-memo 向けに簡素化した（useCase/policy なし・改行モードは settings から）。
 *
 * fail-closed:
 *   - buildQrPages の throw（1 文字も入らない等）→ ダイアログ内にエラー文言を表示
 *   - drawQrToCanvas の throw（容量超過・2d context なし）→ ページ表示をエラー文言へ
 *     置き換える（握りつぶして空 QR を見せない）
 * 表示中は useWakeLock で画面スリープを抑止し、閉じる（unmount）で解放する。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Modal } from '@snishi/foundation/ui/Modal';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Icon } from '@snishi/foundation/ui/Icon';
import { drawQrToCanvas } from '@snishi/foundation/qr/render';
import { useAutoPager } from '@snishi/foundation/qr/useAutoPager';
import { useWakeLock } from '@snishi/foundation/ui/useWakeLock';
import { buildQrPages, QR_CHAR_TOO_LONG_MSG } from '../domain/qrText';
import { errorText, t } from '../i18n';
import { useStore } from './useStore';

/** 自動送り間隔 (ms)。スマホカメラが取りこぼしにくい実測値（medical と同値）。 */
const QR_AUTO_ADVANCE_MS = 900;

/**
 * チェックボックス行のタップ領域 44px（AGENTS.md）を、共有 app.css を編集せず
 * インラインで担保する（QR 専用クラスの追加は統合時に検討）。
 */
const toggleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
};

const errorTextStyle: CSSProperties = { color: 'var(--danger)' };

export function QrDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const { settings } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  // 分割はダイアログを開いた時点の text と改行モードで確定する。throw は
  // ここで catch してエラー文言に変換する（1 文字も入らない場合は専用文言）。
  const built = useMemo<{ pages: string[]; error: null } | { pages: null; error: string }>(() => {
    try {
      return { pages: buildQrPages(text, settings.newlineMode), error: null };
    } catch (e) {
      const message =
        e instanceof Error && e.message === QR_CHAR_TOO_LONG_MSG ? t('qr.tooLong') : errorText(e);
      return { pages: null, error: message };
    }
  }, [text, settings.newlineMode]);

  const pages = built.pages;
  const total = pages ? pages.length : 0;

  // 自動送りは止めた状態で開く（読み取り側は 1 ページずつ貼り付ける運用のため）。
  const pager = useAutoPager(total, {
    intervalMs: QR_AUTO_ADVANCE_MS,
    active: total > 1,
    initialPlaying: false,
  });
  const currentPage = pages ? (pages[pager.index] ?? '') : '';

  // 表示中はスリープ抑止（閉じる = unmount で hook が解放する）。
  useWakeLock(true);

  useEffect(() => {
    if (pages === null || pages.length === 0) return;
    // ダイアログのレイアウト確定後に描く（drawQrToCanvas の自動スケールが親要素幅を参照する）。
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        drawQrToCanvas(currentPage, canvas);
        setDrawError(null);
      } catch (e) {
        // fail-closed: 壊れた/描けない QR を成功に見せない。ページ表示をエラー文言へ置き換える。
        console.error('qr draw failed:', e);
        setDrawError(errorText(e));
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [pages, currentPage]);

  return (
    <Modal title={t('qr.title')} onClose={onClose} variant="dialog" closeLabel={t('common.close')}>
      {pages === null ? (
        // 分割段階の失敗: QR は一切出さずエラーだけを見せる。
        <p role="alert" style={errorTextStyle}>
          {built.error}
        </p>
      ) : (
        <>
          {/* 描画失敗時は canvas を隠してエラー文言へ置き換える（ページ切替で再試行される）。 */}
          <div className="tm-qr-canvas-wrap" style={drawError ? { display: 'none' } : undefined}>
            <canvas ref={canvasRef} />
          </div>
          {drawError !== null ? (
            <p role="alert" style={errorTextStyle}>
              {drawError}
            </p>
          ) : null}

          {/* ページ表示 + 前/次（単一ページでは切替ボタンを出さない） */}
          <div className="toolbar" style={{ alignItems: 'center', marginBottom: 0 }}>
            <span className="muted">{t('qr.page', { n: pager.index + 1, total })}</span>
            {total > 1 ? (
              <>
                <IconButton
                  label={t('qr.prevPage')}
                  onClick={pager.prev}
                  disabled={pager.index <= 0}
                  style={{ marginLeft: 'auto' }}
                >
                  {/* chevronRight を左右反転して「前へ」にする（foundation に左向きグリフがないため） */}
                  <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
                    <Icon name="chevronRight" size={20} />
                  </span>
                </IconButton>
                <IconButton
                  label={t('qr.nextPage')}
                  onClick={pager.next}
                  disabled={pager.index >= total - 1}
                >
                  <Icon name="chevronRight" size={20} />
                </IconButton>
              </>
            ) : null}
          </div>

          {total > 1 ? (
            <>
              <label style={toggleRowStyle}>
                <input
                  type="checkbox"
                  checked={pager.playing}
                  onChange={pager.toggle}
                  style={{ width: 20, height: 20 }}
                />
                {t('qr.autoPage')}
              </label>
              <p className="muted">{t('qr.multiPageNote')}</p>
            </>
          ) : null}

          {/* 元テキスト確認: QR に実際に載る改行変換後のテキスト（分割前の全文） */}
          <label style={toggleRowStyle}>
            <input
              type="checkbox"
              checked={showSource}
              onChange={(e) => setShowSource(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            {t('qr.showText')}
          </label>
          {showSource ? <div className="tm-qr-source">{pages.join('')}</div> : null}
        </>
      )}
    </Modal>
  );
}
