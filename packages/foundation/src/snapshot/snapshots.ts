// スナップショット(復元ポイント)ストア。scope などアプリ固有の知識は注入で受け取る。
import { createDatabase } from '../storage/idb';
import type { PointerStore } from '../storage/pointers';

const STORE = 'snapshots';
const DEFAULT_TTL_DAYS = 14;
const DEFAULT_NAV_KEEP = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** navReason の既定値(画面遷移直前の浅いアンドゥ)。 */
export const DEFAULT_NAV_REASON = 'nav';
/** restoreUndoReason の既定値(復元直前に自動で積まれる undo スナップショット)。 */
export const DEFAULT_RESTORE_UNDO_REASON = 'restore_undo';

export interface SnapshotStoreConfig<TData> {
  dbName: string;
  /** 失効日数。PII を含み得るため短い既定(14 日)。 */
  ttlDays?: number;
  /** scope ごとに保持する nav スナップショット数(既定 2)。 */
  navKeep?: number;
  /** 破壊操作前の reason 一覧(scope ごと同日初回のみ撮影する dedup の対象)。 */
  destructiveReasons: readonly string[];
  /** 直近 navKeep 枚のリング保持対象 reason(直近と同 signature ならスキップ)。既定 'nav'。 */
  navReason?: string;
  /** 復元直前に自動で積まれる undo の reason。既定 'restore_undo'。 */
  restoreUndoReason?: string;
  /** nav dedup 用の変化検出署名。 */
  signatureOf: (data: TData) => string;
  /** purge 失敗追跡の tombstone 置き場(アプリの prefix 付き PointerStore)。 */
  tombstones: PointerStore;
  /**
   * 撮影時の所有ユーザー(その時の作業ユーザー)ID。注入すると capture / restore undo の
   * レコードへ ownerId が記録され、purgeForOwner のユーザー次元掃除が可能になる。
   * 未注入・空値なら従来どおり owner なしで記録する(後方互換)。
   */
  ownerOf?: () => string | null | undefined;
  /** テスト注入用の現在時刻。 */
  now?: () => number;
}

export interface RestorePoint {
  id: number;
  t: number;
  reason: string;
  scopeId: string;
  label: string;
  /** 撮影時の所有ユーザー(cfg.ownerOf 注入時のみ)。旧レコードには無い。 */
  ownerId?: string;
}

export type RestoreResult = { ok: true } | { ok: false; reason: 'notfound' | 'expired' | 'save' };

export interface PurgeResult {
  ok: boolean;
  count: number;
  reason?: 'scan' | 'delete';
}

export interface SnapshotStore<TData> {
  /** 起動時: TTL 失効分の削除 + 前回 purge 失敗分(tombstone)の再実行。 */
  init(): Promise<void>;
  capture(reason: string, scopeId: string, data: TData, label?: string): Promise<void>;
  /** 復元ポイント一覧(新しい順)。scopeId 省略時は全 scope。失効分は読み出し時にも隠す。 */
  list(scopeId?: string): Promise<RestorePoint[]>;
  /**
   * 復元(履歴保持型): 復元前に currentData を 'restore_undo' として撮ってから apply を実行する。
   * apply が throw したら {ok:false, reason:'save'}(fail-closed)。このとき foundation 側は
   * 巻き戻さないので、**apply 側が live 状態のロールバック責務を持つ**。
   */
  restore(
    id: number,
    currentData: TData,
    apply: (data: TData) => Promise<void>,
  ): Promise<RestoreResult>;
  deleteOne(id: number): Promise<void>;
  /**
   * scope 群のスナップショットを全削除する。削除完了を確認できるまで tombstone(tombstones)に
   * 積み、成功時のみ除去 → 途中失敗でも次回 init() で再実行され PII を取りこぼさない。
   */
  purgeForScopes(scopeIds: string[]): Promise<PurgeResult>;
  /**
   * 所有ユーザー(ownerId)のスナップショットを scope 横断で全削除する(ユーザー削除時の掃除)。
   * ownerId の無い旧レコードは対象外(推測 purge で他ユーザー分を巻き添えにしない。TTL で消える)。
   * tombstone の fail-closed 追跡は purgeForScopes と同型(owner 用の第2キー)。
   */
  purgeForOwner(ownerId: string): Promise<PurgeResult>;
  _resetForTests(): void;
}

type NewSnapshot<TData> = {
  scopeId: string;
  t: number;
  reason: string;
  label: string;
  sig: string;
  data: TData;
  ownerId?: string;
};
type StoredSnapshot<TData> = NewSnapshot<TData> & { id: number };

// ローカル日付キー(YYYYMMDD)。「同日」判定は端末ローカル時刻基準。
function localDayKey(t: number): number {
  const d = new Date(t);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function createSnapshotStore<TData>(cfg: SnapshotStoreConfig<TData>): SnapshotStore<TData> {
  const ttlDays = cfg.ttlDays ?? DEFAULT_TTL_DAYS;
  const navKeep = cfg.navKeep ?? DEFAULT_NAV_KEEP;
  const navReason = cfg.navReason ?? DEFAULT_NAV_REASON;
  const restoreUndoReason = cfg.restoreUndoReason ?? DEFAULT_RESTORE_UNDO_REASON;
  const isDestructive = (reason: string): boolean => cfg.destructiveReasons.includes(reason);
  const now = cfg.now ?? Date.now;
  // tombstone キーに dbName を含める(同じ PointerStore を複数 snapshot store で共有しても衝突しない)。
  // scope 次元と owner 次元は別キー(scopeId と userId の値空間を 1 リストに混ぜない)。
  const tombstoneKey = `snapshot_purge_pending:${cfg.dbName}`;
  const ownerTombstoneKey = `snapshot_purge_pending_owner:${cfg.dbName}`;

  const handle = createDatabase({
    name: cfg.dbName,
    version: 1,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    },
  });

  function cutoffNow(): number {
    return now() - ttlDays * MS_PER_DAY;
  }

  async function listForScope(scopeId: string): Promise<StoredSnapshot<TData>[]> {
    const all = await handle.getAll<StoredSnapshot<TData>>(STORE);
    return all.filter((s) => s.scopeId === scopeId);
  }

  async function addRecord(rec: NewSnapshot<TData>): Promise<void> {
    await handle.runWrite([STORE], (tx) => {
      tx.objectStore(STORE).add(rec);
    });
  }

  async function deleteIds(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await handle.runWrite([STORE], (tx) => {
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
    });
  }

  // scope ごとの間引き: TTL 超過分 + nav の navKeep 超過分(古い順)を削除。
  async function pruneScope(scopeId: string): Promise<void> {
    try {
      const all = await listForScope(scopeId);
      const cutoff = cutoffNow();
      const toDelete: number[] = [];
      for (const s of all) if (s.t < cutoff) toDelete.push(s.id);
      const navAlive = all
        .filter((s) => s.reason === navReason && s.t >= cutoff)
        .sort((a, b) => b.t - a.t);
      for (const s of navAlive.slice(navKeep)) toDelete.push(s.id);
      await deleteIds(toDelete);
    } catch (e) {
      console.warn('snapshot prune failed:', e);
    }
  }

  // ── purge tombstone(tombstones)──
  function readTombstone(key: string): string[] {
    const raw = cfg.tombstones.get(key);
    if (!raw) return [];
    try {
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr)
        ? arr.filter((x): x is string => typeof x === 'string' && x !== '')
        : [];
    } catch {
      return [];
    }
  }

  function writeTombstone(key: string, ids: string[]): void {
    const uniq = [...new Set(ids)];
    if (!uniq.length) cfg.tombstones.remove(key);
    else cfg.tombstones.set(key, JSON.stringify(uniq));
  }

  function addTombstone(key: string, ids: string[]): void {
    writeTombstone(key, [...readTombstone(key), ...ids]);
  }

  function removeTombstone(key: string, ids: string[]): void {
    const drop = new Set(ids);
    writeTombstone(
      key,
      readTombstone(key).filter((id) => !drop.has(id)),
    );
  }

  // 実際の削除(scan + delete)。tombstone は触らない。「0 件成功」と「失敗」を ok で区別する。
  async function purgeWhere(match: (s: StoredSnapshot<TData>) => boolean): Promise<PurgeResult> {
    let toDelete: number[];
    try {
      const all = await handle.getAll<StoredSnapshot<TData>>(STORE);
      toDelete = all.filter(match).map((s) => s.id);
    } catch (e) {
      console.warn('snapshot purge scan failed:', e);
      return { ok: false, count: 0, reason: 'scan' };
    }
    if (!toDelete.length) return { ok: true, count: 0 };
    try {
      await deleteIds(toDelete);
    } catch (e) {
      console.warn('snapshot purge delete failed:', e);
      return { ok: false, count: 0, reason: 'delete' };
    }
    return { ok: true, count: toDelete.length };
  }

  function purgeNow(scopeIds: string[]): Promise<PurgeResult> {
    const targets = new Set(scopeIds);
    return purgeWhere((s) => targets.has(s.scopeId));
  }

  // owner の無い旧レコードは対象外(ownerId 未設定 = 誰の分か断定できないので推測で消さない)。
  function purgeNowForOwners(ownerIds: string[]): Promise<PurgeResult> {
    const targets = new Set(ownerIds);
    return purgeWhere((s) => typeof s.ownerId === 'string' && targets.has(s.ownerId));
  }

  return {
    async init() {
      try {
        const cutoff = cutoffNow();
        const all = await handle.getAll<StoredSnapshot<TData>>(STORE);
        await deleteIds(all.filter((s) => s.t < cutoff).map((s) => s.id));
      } catch (e) {
        console.warn('snapshot init prune failed:', e);
      }
      // 前回 purge に失敗した scope / owner(PII)を再試行する(best-effort で捨てない)。
      const pending = readTombstone(tombstoneKey);
      if (pending.length) {
        const res = await purgeNow(pending);
        if (res.ok) removeTombstone(tombstoneKey, pending);
        else console.warn('snapshot deferred purge retry failed:', res.reason);
      }
      const pendingOwners = readTombstone(ownerTombstoneKey);
      if (pendingOwners.length) {
        const res = await purgeNowForOwners(pendingOwners);
        if (res.ok) removeTombstone(ownerTombstoneKey, pendingOwners);
        else console.warn('snapshot deferred owner purge retry failed:', res.reason);
      }
    },

    // dedup: nav は直近と同 signature ならスキップ / 破壊的 reason は同日初回のみ。
    // それ以外の reason(restore_undo 等)は dedup なしで常に撮る。
    // スナップショットは保険であり主操作を塞がない(失敗は warn で縮退する)。
    async capture(reason, scopeId, data, label = '') {
      if (!scopeId) return;
      try {
        const t = now();
        // JSON 経由ではなく structuredClone(Date/undefined 等を壊さない、仕様§8)。
        const cloned = structuredClone(data);
        const sig = cfg.signatureOf(cloned);
        const existing = await listForScope(scopeId);
        if (reason === navReason) {
          const newest = [...existing].sort((a, b) => b.t - a.t)[0];
          if (newest && newest.sig === sig) return; // 変化なし → 撮らない
        } else if (isDestructive(reason)) {
          const today = localDayKey(t);
          const sameDay = existing.some(
            (s) => isDestructive(s.reason) && localDayKey(s.t) === today,
          );
          if (sameDay) return; // 同日再操作で「昨日」を上書きしない(初回優先)
        }
        const ownerId = cfg.ownerOf?.() || undefined;
        await addRecord({
          scopeId,
          t,
          reason,
          label,
          sig,
          data: cloned,
          ...(ownerId ? { ownerId } : {}),
        });
        await pruneScope(scopeId);
      } catch (e) {
        console.warn('snapshot capture failed:', e);
      }
    },

    async list(scopeId) {
      try {
        const all = await handle.getAll<StoredSnapshot<TData>>(STORE);
        const cutoff = cutoffNow();
        return all
          .filter((s) => s.t >= cutoff && (scopeId === undefined || s.scopeId === scopeId))
          .sort((a, b) => b.t - a.t)
          .map((s) => ({
            id: s.id,
            t: s.t,
            reason: s.reason,
            scopeId: s.scopeId,
            label: s.label,
            ...(s.ownerId ? { ownerId: s.ownerId } : {}),
          }));
      } catch (e) {
        console.warn('snapshot list failed:', e);
        return [];
      }
    },

    async restore(id, currentData, apply) {
      let snap: StoredSnapshot<TData> | undefined;
      try {
        snap = await handle.get<StoredSnapshot<TData>>(STORE, id);
      } catch (e) {
        console.warn('snapshot restore get failed:', e);
        snap = undefined;
      }
      if (!snap) return { ok: false, reason: 'notfound' };
      // 失効分は復元しない(間引き未実行でも失効後のデータを戻さない読み出し時 TTL 防御)。
      if (snap.t < cutoffNow()) return { ok: false, reason: 'expired' };

      // 1) 現状を「復元の取り消し」用に撮る(同日 dedup を避けるため直接 add)。
      // undo も現在の作業ユーザーのデータなので ownerId を同じく記録する(ユーザー削除 purge の対象)。
      try {
        const cur = structuredClone(currentData);
        const ownerId = cfg.ownerOf?.() || undefined;
        await addRecord({
          scopeId: snap.scopeId,
          t: now(),
          reason: restoreUndoReason,
          label: '',
          sig: cfg.signatureOf(cur),
          data: cur,
          ...(ownerId ? { ownerId } : {}),
        });
      } catch (e) {
        console.warn('snapshot restore undo capture failed:', e);
      }

      // 2) apply(fail-closed: throw を成功扱いにしない。ロールバックは apply 側の責務)。
      try {
        await apply(structuredClone(snap.data));
      } catch (e) {
        console.error('snapshot restore apply failed:', e);
        return { ok: false, reason: 'save' };
      }
      await pruneScope(snap.scopeId);
      return { ok: true };
    },

    async deleteOne(id) {
      try {
        await handle.deleteRecord(STORE, id);
      } catch (e) {
        console.warn('snapshot deleteOne failed:', e);
      }
    },

    async purgeForScopes(scopeIds) {
      const ids = scopeIds.filter(Boolean);
      if (!ids.length) return { ok: true, count: 0 };
      // 削除完了を確認できるまで tombstone で追跡する(fail-closed: best-effort で捨てない)。
      addTombstone(tombstoneKey, ids);
      const res = await purgeNow(ids);
      if (res.ok) removeTombstone(tombstoneKey, ids);
      return res;
    },

    async purgeForOwner(ownerId) {
      if (!ownerId) return { ok: true, count: 0 };
      addTombstone(ownerTombstoneKey, [ownerId]);
      const res = await purgeNowForOwners([ownerId]);
      if (res.ok) removeTombstone(ownerTombstoneKey, [ownerId]);
      return res;
    },

    _resetForTests() {
      handle._resetForTests();
    },
  };
}
