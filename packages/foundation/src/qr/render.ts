// 移植元: snishi-code-medical/hospital-rounds/src/features/qr-flow.js (drawQrToCanvas)
import { qrcodegen } from './vendor/qrcodegen.js';

export interface DrawQrOptions {
  // 1 モジュールあたりのピクセル数。省略時は親要素幅 + devicePixelRatio から自動算出
  scale?: number;
  border?: number;
}

// text を QR (ECC LOW) として canvas に描画する。失敗 (容量超過・2d context なし) は
// throw する (握って空 QR を成功扱いにしない)。
export function drawQrToCanvas(
  text: string,
  canvas: HTMLCanvasElement,
  opts: DrawQrOptions = {},
): void {
  const ecl = qrcodegen.QrCode.Ecc.LOW;
  const qr = qrcodegen.QrCode.encodeText(text, ecl);
  const border = opts.border ?? 4;
  const modules = qr.size + border * 2;

  let scale: number;
  if (typeof opts.scale === 'number' && opts.scale > 0) {
    scale = Math.floor(opts.scale);
  } else {
    // v1 と同じ自動スケール: 親幅 × dpr からモジュールが整数ピクセルになる scale を選ぶ
    // (非整数 scale はモジュール欠け・にじみでスキャン失敗の原因になる)
    const parentW = canvas.parentElement?.clientWidth || 800;
    const cssW = Math.max(240, Math.min(parentW, 980));
    const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    scale = Math.max(2, Math.floor((cssW * dpr) / modules));
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.maxWidth = cssW + 'px';
  }

  const sizePx = modules * scale;
  canvas.width = sizePx;
  canvas.height = sizePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sizePx, sizePx);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }
}
