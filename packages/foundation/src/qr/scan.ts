// 移植元: snishi-code-medical/hospital-rounds/src/features/qr-scan.js (overlay UI を除く stream 部)
import jsQR from 'jsqr';

// ライブ tick は同一 QR を連続検出するため、デデュプ窓で同一テキストの多重発火を抑える
const DEFAULT_DEDUP_MS = 2000;

export function isScannerSupported(): boolean {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export interface ScanSession {
  stop(): void;
}

export interface ScanOptions {
  // 同一テキストの再発火を抑える窓 (ms)。既定は v1 と同じ 2000
  dedupMs?: number;
  // カメラ向き。既定は v1 と同じ背面カメラ優先
  facingMode?: ConstrainDOMString;
}

// カメラ + jsQR の連続スキャン。getUserMedia の呼び出しはこの関数に閉じる
// (カメラ取得は外部送信ではない)。onResult が true を返したら停止する。
// stop() は何度呼んでも安全 (カメラ track を確実に解放する)。
export function scanQrStream(
  video: HTMLVideoElement,
  onResult: (text: string) => boolean | void,
  opts: ScanOptions = {},
): ScanSession {
  const dedupMs = opts.dedupMs ?? DEFAULT_DEDUP_MS;
  let stopped = false;
  let rafId = 0;
  let stream: MediaStream | null = null;
  let lastText: string | null = null;
  let lastTime = 0;
  const canvas = document.createElement('canvas');

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    video.srcObject = null;
  }

  function tick(): void {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, w, h);
        let imageData: ImageData | null;
        try {
          imageData = ctx.getImageData(0, 0, w, h);
        } catch {
          imageData = null; // フレーム未確定等。次の tick で再試行
        }
        if (imageData) {
          const found = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });
          if (found && found.data) {
            const text = found.data;
            const now = Date.now();
            const isDup = text === lastText && now - lastTime < dedupMs;
            if (!isDup) {
              lastText = text;
              lastTime = now;
              let result: boolean | void;
              try {
                result = onResult(text);
              } catch (e) {
                // ハンドラ例外でスキャンループ自体は止めない (v1 と同じ)
                console.error('scan handler error', e);
                result = undefined;
              }
              if (result === true) {
                stop();
                return;
              }
            }
          }
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: opts.facingMode ?? { ideal: 'environment' } },
        audio: false,
      });
      if (stopped) {
        // 起動完了前に stop() された場合も track を解放する
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      tick();
    } catch (e) {
      console.error('camera start failed', e);
      stop();
    }
  })();

  return { stop };
}
