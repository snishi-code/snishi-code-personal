// createEventLog: roundtrip / retention / 例外吸収を fake-indexeddb で検証する。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventLog } from './createEventLog';

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;
const uniqueName = () => `eventlog-test-${Date.now()}-${seq++}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createEventLog', () => {
  it('log → exportAll roundtrip (t/u/k/extra) と clear', async () => {
    const dbName = uniqueName();
    const log = createEventLog({ dbName, getUserId: () => 'u1' });
    await log.init();

    log.log('app_open', { detail: 'x' });
    const dump = await vi.waitFor(async () => {
      const d = await log.exportAll();
      expect(d.events).toHaveLength(1);
      return d;
    });

    expect(dump.format).toBe(dbName);
    expect(dump.schema).toBe(1);
    expect(typeof dump.exportedAt).toBe('string');
    const ev = dump.events[0] as Record<string, unknown>;
    expect(ev.k).toBe('app_open');
    expect(ev.u).toBe('u1');
    expect(ev.detail).toBe('x');
    expect(typeof ev.t).toBe('number');

    await log.clear();
    expect((await log.exportAll()).events).toHaveLength(0);
  });

  it('getUserId 未指定なら u を省略する', async () => {
    const log = createEventLog({ dbName: uniqueName() });
    log.log('k1');
    const dump = await vi.waitFor(async () => {
      const d = await log.exportAll();
      expect(d.events).toHaveLength(1);
      return d;
    });
    expect('u' in (dump.events[0] as Record<string, unknown>)).toBe(false);
  });

  it('init が retention 超過イベントを間引く (366 日前は消え、新しいものは残る)', async () => {
    const base = Date.now();
    let fakeNow = base - 366 * DAY_MS;
    const log = createEventLog({ dbName: uniqueName(), now: () => fakeNow });

    log.log('old');
    fakeNow = base;
    log.log('fresh');
    await vi.waitFor(async () => {
      expect((await log.exportAll()).events).toHaveLength(2);
    });

    await log.init(); // 既定 365 日: cutoff より古い 'old' だけ消える
    const dump = await log.exportAll();
    expect(dump.events).toHaveLength(1);
    expect((dump.events[0] as Record<string, unknown>).k).toBe('fresh');
  });

  it('log は getUserId が throw しても throw しない (fire-and-forget)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createEventLog({
      dbName: uniqueName(),
      getUserId: () => {
        throw new Error('boom');
      },
    });
    expect(() => log.log('x')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('IndexedDB が壊れていても全 API が安全に動く (DB 無し扱い)', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('broken');
      },
    });
    const log = createEventLog({ dbName: uniqueName() });

    await expect(log.init()).resolves.toBeUndefined();
    expect(() => log.log('x')).not.toThrow();
    const dump = await log.exportAll();
    expect(dump.events).toEqual([]);
    await expect(log.clear()).resolves.toBeUndefined();
  });
});
