// 巻き戻しスナップショット (コピー元: hospital-workspace/rounds/data/snapshots.ts。
// owner=userId 次元は剥離)。dedup/TTL/tombstone/復元は foundation 側 (createSnapshotStore)。
// ここでは REASON / DB 名 / 署名関数だけ注入する。

import { createSnapshotStore, type SnapshotStore } from '@snishi/foundation/snapshot/snapshots';
import type { PointerStore } from '@snishi/foundation/storage/pointers';
import { type Patient } from '../domain/types';
import { isPatientEmpty } from '../domain/normalize';
import { SNAPSHOT_DB_NAME } from './constants';

export const REASON = Object.freeze({
  CLEAR: 'clear',
  MOVE: 'move',
  PATIENT_DELETE: 'patient_delete',
  DELETE: 'delete',
  IMPORT: 'import',
  RESTORE_UNDO: 'restore_undo',
  NAV: 'nav',
} as const);

const SNAPSHOT_TTL_DAYS = 14;
const SNAPSHOT_NAV_KEEP = 2;

const DESTRUCTIVE_REASONS = [
  REASON.CLEAR,
  REASON.MOVE,
  REASON.PATIENT_DELETE,
  REASON.DELETE,
  REASON.IMPORT,
] as const;

export interface SnapshotData {
  title: string;
  patients: Patient[];
}

function hashPatients(patients: readonly Patient[]): string {
  let s: string;
  try {
    s = JSON.stringify(patients);
  } catch {
    s = '';
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

export function countActivePatients(patients: readonly Patient[]): number {
  return (Array.isArray(patients) ? patients : []).filter((p) => p && !isPatientEmpty(p)).length;
}

export function createHrSnapshots(
  tombstones: PointerStore,
  now?: () => number,
): SnapshotStore<SnapshotData> {
  return createSnapshotStore<SnapshotData>({
    dbName: SNAPSHOT_DB_NAME,
    ttlDays: SNAPSHOT_TTL_DAYS,
    navKeep: SNAPSHOT_NAV_KEEP,
    destructiveReasons: DESTRUCTIVE_REASONS,
    navReason: REASON.NAV,
    restoreUndoReason: REASON.RESTORE_UNDO,
    signatureOf: (data) => hashPatients(data.patients),
    tombstones,
    now,
  });
}
