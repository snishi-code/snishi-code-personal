import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPointerStore } from './pointers';

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

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorageStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage/pointers', () => {
  it('get/set/remove/keys の基本動作', () => {
    const store = createPointerStore('app_a:');
    expect(store.get('k1')).toBeNull();
    store.set('k1', 'v1');
    store.set('k2', 'v2');
    expect(store.get('k1')).toBe('v1');
    expect(store.keys().sort()).toEqual(['k1', 'k2']);
    // 実体は prefix 付きで保存される
    expect(localStorage.getItem('app_a:k1')).toBe('v1');

    store.remove('k1');
    expect(store.get('k1')).toBeNull();
    expect(store.keys()).toEqual(['k2']);
  });

  it('clearAll は prefix 一致キーだけ削除し、他のキーは残す', () => {
    const a = createPointerStore('app_a:');
    const b = createPointerStore('app_b:');
    a.set('k1', 'a1');
    a.set('k2', 'a2');
    b.set('k1', 'b1');
    localStorage.setItem('unrelated', 'x');

    a.clearAll();

    expect(a.keys()).toEqual([]);
    expect(b.get('k1')).toBe('b1');
    expect(localStorage.getItem('app_b:k1')).toBe('b1');
    expect(localStorage.getItem('unrelated')).toBe('x');
  });

  it('別 prefix の keys は互いに混ざらない', () => {
    const a = createPointerStore('app_a:');
    const b = createPointerStore('app_b:');
    a.set('k1', 'a1');
    b.set('k9', 'b9');
    expect(a.keys()).toEqual(['k1']);
    expect(b.keys()).toEqual(['k9']);
  });

  it('localStorage が使えない環境では throw せず no-op になる', () => {
    vi.stubGlobal('localStorage', undefined);
    const store = createPointerStore('app_a:');
    expect(() => store.set('k1', 'v1')).not.toThrow();
    expect(store.get('k1')).toBeNull();
    expect(store.keys()).toEqual([]);
    expect(() => store.clearAll()).not.toThrow();
  });
});
