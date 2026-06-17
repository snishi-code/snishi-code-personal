// 移植元: hospital-rounds src/storage.js の localStorage ポインタ群の汎用化(prefix 名前空間化)

export interface PointerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** prefix 配下のキー一覧(prefix を除いた名前で返す)。 */
  keys(): string[];
  /** prefix 配下のキーのみ全削除。 */
  clearAll(): void;
}

// SSR / プライベートモード等では localStorage の参照やアクセス自体が throw し得る。
// ポインタは数バイトの補助情報なので throw せず no-op + warn で縮退する。
function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function createPointerStore(prefix: string): PointerStore {
  const full = (key: string): string => prefix + key;

  function warn(op: string, e?: unknown): void {
    console.warn(`PointerStore(${prefix}): localStorage unavailable, ${op} is a no-op`, e ?? '');
  }

  function keys(): string[] {
    const ls = storageOrNull();
    if (!ls) {
      warn('keys');
      return [];
    }
    const out: string[] = [];
    try {
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
    } catch (e) {
      warn('keys', e);
      return [];
    }
    return out;
  }

  return {
    get(key) {
      const ls = storageOrNull();
      if (!ls) {
        warn('get');
        return null;
      }
      try {
        return ls.getItem(full(key));
      } catch (e) {
        warn('get', e);
        return null;
      }
    },
    set(key, value) {
      const ls = storageOrNull();
      if (!ls) {
        warn('set');
        return;
      }
      try {
        ls.setItem(full(key), value);
      } catch (e) {
        // 容量超過(プライベートモードの quota 0 など)も no-op に倒す。
        warn('set', e);
      }
    },
    remove(key) {
      const ls = storageOrNull();
      if (!ls) {
        warn('remove');
        return;
      }
      try {
        ls.removeItem(full(key));
      } catch (e) {
        warn('remove', e);
      }
    },
    keys,
    clearAll() {
      // localStorage.clear() は同一 origin の他モジュール/他アプリのキーまで巻き添えにするため
      // 使わない(仕様§7)。必ず prefix 一致キーだけを削除する。
      const ls = storageOrNull();
      if (!ls) {
        warn('clearAll');
        return;
      }
      try {
        for (const k of keys()) ls.removeItem(full(k));
      } catch (e) {
        warn('clearAll', e);
      }
    },
  };
}
