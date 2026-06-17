import { describe, it, expect, vi } from 'vitest';
import { createReceiverRegistry, type ReceiveCtrl } from './receiverRegistry.js';

const ctrl: ReceiveCtrl = { setStatus: () => {}, close: () => {} };
const page = (kind: string) => `RND_${kind} #b1 1/1\nbody`;

describe('createReceiverRegistry', () => {
  it('形式不正は unknown-format / consumed:false (入力を残す)', () => {
    const reg = createReceiverRegistry(['ST']);
    expect(reg.route('garbage', ctrl)).toEqual({
      done: false,
      consumed: false,
      reason: 'unknown-format',
      kind: null,
    });
  });

  it('allowlist 外の kind は kind-not-allowed (登録済みでも通さない)', () => {
    const reg = createReceiverRegistry<string>(['ST']);
    reg.register('HM', { kindLabel: 'ホーム', receivePage: () => 'hm' });
    expect(reg.route(page('HM'), ctrl)).toMatchObject({ reason: 'kind-not-allowed', kind: 'HM' });
  });

  it('対象 kind でも未登録なら no-receiver', () => {
    const reg = createReceiverRegistry(['ST']);
    expect(reg.route(page('ST'), ctrl)).toMatchObject({ reason: 'no-receiver', kind: 'ST' });
  });

  it('登録済み receiver に text と ctrl がそのまま渡り、結果を透過する', () => {
    const reg = createReceiverRegistry<{ done: boolean }>(['ST', 'FMT']);
    const receivePage = vi.fn().mockReturnValue({ done: true });
    reg.register('FMT', { kindLabel: 'フォーマット', receivePage });
    expect(reg.route(page('FMT'), ctrl)).toEqual({ done: true });
    expect(receivePage).toHaveBeenCalledWith(page('FMT'), ctrl);
    expect(reg.get('FMT')?.kindLabel).toBe('フォーマット');
    expect(reg.get('ST')).toBeNull();
  });

  it('allowlist 省略時は登録済み kind をすべて受け付ける', () => {
    const reg = createReceiverRegistry<string>();
    reg.register('ZZ', { kindLabel: 'z', receivePage: () => 'ok' });
    expect(reg.route(page('ZZ'), ctrl)).toBe('ok');
    expect(reg.route(page('QQ'), ctrl)).toMatchObject({ reason: 'no-receiver', kind: 'QQ' });
  });

  it('receivePage を持たない不正 handler は登録されない (fail-closed)', () => {
    const reg = createReceiverRegistry(['ST']);
    reg.register('ST', { kindLabel: 'x' } as never);
    expect(reg.get('ST')).toBeNull();
  });
});
