import { afterEach, describe, expect, it, vi } from 'vitest';
import { isScannerSupported, scanQrStream } from './scan';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isScannerSupported', () => {
  it('mediaDevices.getUserMedia の有無で判定する', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    expect(isScannerSupported()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(isScannerSupported()).toBe(false);
  });
});

describe('scanQrStream onError', () => {
  it('getUserMedia 失敗時に onError を呼ぶ (権限拒否などを握りつぶさない)', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const video = document.createElement('video');
    const onError = vi.fn();

    const session = scanQrStream(video, () => false, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    session.stop();
  });

  it('onError 未指定でも例外を投げない (後方互換)', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('no camera'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const video = document.createElement('video');

    const session = scanQrStream(video, () => false);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(() => session.stop()).not.toThrow();
  });
});
