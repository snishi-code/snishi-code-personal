import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshotStore,
  DEFAULT_RESTORE_UNDO_REASON,
  type SnapshotStoreConfig,
} from './snapshots';
import { createPointerStore } from '../storage/pointers';

// Node 22+ の組み込み localStorage(--localstorage-file 無しでは動作しない)が
// jsdom のものを隠すため、テストでは機能する in-memory Storage に差し替える。
function makeStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
}

interface Data {
  items: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// ローカル日付に依存する dedup テストのため「日中」の時刻を基準にする
const BASE = Date.parse('2026-01-10T03:00:00Z');

let seq = 0;

function setup(over: Partial<SnapshotStoreConfig<Data>> = {}) {
  const dbName = `snap-test-${++seq}`;
  const prefix = `snap_test_${seq}:`;
  let nowValue = BASE;
  const tombstones = createPointerStore(prefix);
  const store = createSnapshotStore<Data>({
    dbName,
    destructiveReasons: ['clear', 'delete', 'import'],
    signatureOf: (d) => JSON.stringify(d),
    tombstones,
    now: () => nowValue,
    ...over,
  });
  return {
    store,
    tombstones,
    dbName,
    setNow: (t: number) => {
      nowValue = t;
    },
    advance: (ms: number) => {
      nowValue += ms;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorageStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('snapshot/snapshots', () => {
  it('TTL: 失効分は list から隠れ、init で物理削除される', async () => {
    const { store, setNow } = setup();
    await store.capture('clear', 's1', { items: ['a'] });
    expect(await store.list('s1')).toHaveLength(1);

    // 15 日後: 読み出し時 TTL 防御で隠れる
    setNow(BASE + 15 * DAY);
    expect(await store.list('s1')).toEqual([]);

    // init で物理削除 → TTL 内に見える時点へ戻しても出てこない(= 実際に消えている)
    await store.init();
    setNow(BASE + 13 * DAY);
    expect(await store.list('s1')).toEqual([]);
  });

  it('nav: 直近と signature が同じならスキップする', async () => {
    const { store, advance } = setup();
    await store.capture('nav', 's1', { items: ['a'] });
    advance(1000);
    await store.capture('nav', 's1', { items: ['a'] }); // 変化なし → 撮らない
    expect(await store.list('s1')).toHaveLength(1);

    advance(1000);
    await store.capture('nav', 's1', { items: ['b'] });
    expect(await store.list('s1')).toHaveLength(2);
  });

  it('nav: navKeep 超過分(古い順)が削除される', async () => {
    const { store, advance } = setup({ navKeep: 2 });
    await store.capture('nav', 's1', { items: ['a'] });
    advance(1000);
    await store.capture('nav', 's1', { items: ['b'] });
    advance(1000);
    await store.capture('nav', 's1', { items: ['c'] });

    const points = await store.list('s1');
    expect(points).toHaveLength(2);
    // 新しい順で、残るのは後から撮った 2 枚
    expect(points[0]?.t).toBe(BASE + 2000);
    expect(points[1]?.t).toBe(BASE + 1000);
  });

  it('破壊的 reason: 同日 2 回目はスキップし、翌日は撮れる', async () => {
    const { store, advance } = setup();
    await store.capture('clear', 's1', { items: ['a'] });
    advance(HOUR);
    await store.capture('delete', 's1', { items: ['b'] }); // 同日 → 初回優先で撮らない
    expect(await store.list('s1')).toHaveLength(1);

    advance(DAY);
    await store.capture('clear', 's1', { items: ['c'] });
    expect(await store.list('s1')).toHaveLength(2);
  });

  it('nav/destructive いずれでもない reason は dedup なしで毎回撮れる', async () => {
    const { store, advance } = setup();
    await store.capture('manual', 's1', { items: ['a'] });
    advance(1000);
    await store.capture('manual', 's1', { items: ['a'] }); // 同内容・同日でも撮る
    expect(await store.list('s1')).toHaveLength(2);
  });

  it('navReason / restoreUndoReason は注入名で動作する', async () => {
    const { store, advance } = setup({ navReason: 'page', restoreUndoReason: 'undo!' });
    await store.capture('page', 's1', { items: ['a'] });
    advance(1000);
    await store.capture('page', 's1', { items: ['a'] }); // 注入した nav 名で sig dedup
    expect(await store.list('s1')).toHaveLength(1);

    advance(1000);
    const id = (await store.list('s1'))[0]?.id;
    const res = await store.restore(id!, { items: ['current'] }, async () => {});
    expect(res).toEqual({ ok: true });
    expect((await store.list('s1'))[0]?.reason).toBe('undo!');
  });

  it('restore: 復元前に restore_undo を積み、apply には複製データが渡る', async () => {
    const { store, advance } = setup();
    await store.capture('clear', 's1', { items: ['old'] });
    const id = (await store.list('s1'))[0]?.id;
    expect(id).toBeDefined();

    advance(1000);
    const applied: Data[] = [];
    const res = await store.restore(id!, { items: ['current'] }, async (d) => {
      applied.push(d);
    });
    expect(res).toEqual({ ok: true });
    expect(applied).toEqual([{ items: ['old'] }]);

    const points = await store.list('s1');
    expect(points[0]?.reason).toBe(DEFAULT_RESTORE_UNDO_REASON);
  });

  it('restore: apply が throw したら ok:false(reason: save)で、undo は先に積まれている', async () => {
    const { store, advance } = setup();
    await store.capture('clear', 's1', { items: ['old'] });
    const id = (await store.list('s1'))[0]?.id;

    advance(1000);
    const res = await store.restore(id!, { items: ['current'] }, async () => {
      throw new Error('save failed');
    });
    expect(res).toEqual({ ok: false, reason: 'save' });

    // undo は apply より先に撮られているので残っている(復元のやり直しが可能)
    const points = await store.list('s1');
    expect(points[0]?.reason).toBe(DEFAULT_RESTORE_UNDO_REASON);
  });

  it('restore: 失効したスナップショットは復元しない', async () => {
    const { store, setNow } = setup();
    await store.capture('clear', 's1', { items: ['old'] });
    const id = (await store.list('s1'))[0]?.id;

    setNow(BASE + 15 * DAY);
    const res = await store.restore(id!, { items: ['current'] }, async () => {});
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('deleteOne で 1 枚だけ消える', async () => {
    const { store, advance } = setup();
    await store.capture('clear', 's1', { items: ['a'] });
    advance(DAY);
    await store.capture('clear', 's1', { items: ['b'] });
    const points = await store.list('s1');
    expect(points).toHaveLength(2);

    await store.deleteOne(points[0]!.id);
    expect(await store.list('s1')).toHaveLength(1);
  });

  it('purge: 削除失敗で tombstone が残り、init 再実行で回収される', async () => {
    const { store, tombstones, dbName } = setup();
    const tombstoneKey = `snapshot_purge_pending:${dbName}`;
    await store.capture('clear', 's1', { items: ['a'] });
    await store.capture('clear', 's2', { items: ['b'] });

    // 削除を失敗させる(IDB の delete を throw に差し替え)
    const spy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new Error('delete blocked');
    });
    let res;
    try {
      res = await store.purgeForScopes(['s1']);
    } finally {
      spy.mockRestore();
    }
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('delete');
    // 失敗中は tombstone が残る(= 完了扱いにしない)
    expect(tombstones.get(tombstoneKey)).toContain('s1');
    expect(await store.list('s1')).toHaveLength(1);

    // init の再試行で回収され、tombstone も除去される
    await store.init();
    expect(tombstones.get(tombstoneKey)).toBeNull();
    expect(await store.list('s1')).toEqual([]);
    expect(await store.list('s2')).toHaveLength(1);
  });

  it('purge: 成功時は件数を返し tombstone を残さない', async () => {
    const { store, tombstones, dbName } = setup();
    await store.capture('clear', 's1', { items: ['a'] });
    const res = await store.purgeForScopes(['s1']);
    expect(res).toEqual({ ok: true, count: 1 });
    expect(tombstones.get(`snapshot_purge_pending:${dbName}`)).toBeNull();
    expect(await store.list('s1')).toEqual([]);
  });
});
