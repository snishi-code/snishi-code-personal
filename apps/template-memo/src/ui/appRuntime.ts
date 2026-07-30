// アプリ runtime (コピー元: hospital-workspace/rounds/ui/appRuntime.ts)。
// store / snapshots / bump を 1 つの束にして UI へ配る。

import { useSyncExternalStore } from 'react';
import type { SnapshotStore } from '@snishi/foundation/snapshot/snapshots';
import { createHrStore, type HrStore, type StoreChangeEvent } from '../data/store';
import { createHrSnapshots, type SnapshotData } from '../data/snapshots';
import { s } from '../i18n/rounds';

export interface AppRuntime {
  store: HrStore;
  snapshots: SnapshotStore<SnapshotData>;
  bump(): void;
  subscribe(fn: () => void): () => void;
  getRevision(): number;
  setSaveErrorHandler(fn: ((e: unknown) => void) | null): void;
  lastStoreEvent(): StoreChangeEvent | null;
}

export function createRoundsRuntime(): AppRuntime {
  let revision = 0;
  const listeners = new Set<() => void>();
  let saveErrorHandler: ((e: unknown) => void) | null = null;
  let lastEvent: StoreChangeEvent | null = null;

  function bump(): void {
    revision++;
    for (const fn of listeners) fn();
  }

  const store = createHrStore({
    defaultTitle: s.app.title,
    onSaveError(e) {
      if (saveErrorHandler) saveErrorHandler(e);
    },
  });

  store.setDataChangeHandler((ev) => {
    lastEvent = ev;
    bump();
  });

  const snapshots = createHrSnapshots(store.storage.pointers);

  return {
    store,
    snapshots,
    bump,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getRevision: () => revision,
    setSaveErrorHandler(fn) {
      saveErrorHandler = fn;
    },
    lastStoreEvent: () => lastEvent,
  };
}

export function useRevision(runtime: AppRuntime): number {
  return useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision);
}
