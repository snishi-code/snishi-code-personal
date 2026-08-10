import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_IMPORT_ENCRYPTED_MSG,
  WORKSPACE_IMPORT_JSON_UNREADABLE_MSG,
  WORKSPACE_IMPORT_USER_NOT_FOUND_MSG,
  convertWorkspaceBackup,
  listImportCandidates,
  prepareWorkspaceImportAppend,
  workspaceImportSchemaMismatchMsg,
} from './importWorkspace';
import { STATUS } from './types';

const NOW = 1_800_000_000_000;

/** medical 側 buildWorkspaceBackup の envelope / DB schema v7 に沿う合成 fixture。 */
function makeWorkspaceBackup(): Record<string, unknown> {
  return {
    kind: 'HOSPITAL_WORKSPACE_BACKUP',
    version: 1,
    appId: 'hospital-workspace',
    createdAt: '2026-07-30T00:00:00.000Z',
    schemaVersion: 7,
    source: { appVersion: 'test' },
    stores: {
      appSettings: [
        { key: 'app', activeSurface: 'rounds', activeUserId: 'usr_a' },
        {
          key: 'placesConfig',
          items: [
            { placeId: 'place_1', name: '東エリア', showNextVisit: false },
            { placeId: 'place_2', name: '東エリア', showNextVisit: true },
            { placeId: 'place_3', name: '西エリア', showNextVisit: false },
          ],
          updatedAt: 10,
        },
        {
          key: 'roundsConfig',
          aiTemplate: { fixedFields: [] },
          templateRevision: 3,
          closingPreset: 'A: 著変なし',
          updatedAt: 20,
        },
      ],
      users: [
        {
          id: 'usr_a',
          name: '利用者A',
          role: 'member',
          createdAt: 1,
          passhash: null,
        },
        {
          id: 'usr_b',
          name: '利用者B',
          role: 'member',
          createdAt: 2,
          passhash: null,
        },
      ],
      patients: [
        {
          patientId: 'pt_1',
          name: 'サンプル対象1',
          room: 'A-01',
          placeId: 'place_1',
          problems: ['継続課題', '', 42],
          sharedTags: ['移行しない'],
          archivedAt: 777,
          createdAt: 100,
          updatedAt: 110,
        },
        {
          patientId: 'pt_2',
          name: 'サンプル対象2',
          room: 'B-02',
          placeId: 'place_2',
          problems: [],
          createdAt: 200,
          updatedAt: 210,
        },
        {
          patientId: 'pt_3',
          name: 'サンプル対象3',
          room: '',
          placeId: 'missing_place',
          problems: ['確認事項'],
          createdAt: 300,
        },
      ],
      roundsUserStates: [
        {
          key: 'usr_a::pt_1',
          userId: 'usr_a',
          patientId: 'pt_1',
          status: 'green',
          standingMemo: 'Aの継続メモ',
          confirmedNote: 'Aの清書',
          projectedValues: { 'fixed:x': '移行しない' },
          tags: ['移行しない'],
          updatedAt: 120,
        },
        {
          key: 'usr_b::pt_1',
          userId: 'usr_b',
          patientId: 'pt_1',
          status: 'blue',
          standingMemo: 'Bの継続メモ',
          confirmedNote: 'Bの清書',
          projectedValues: {},
          tags: [],
          updatedAt: 130,
        },
        {
          key: 'usr_a::pt_2',
          userId: 'usr_a',
          patientId: 'pt_2',
          status: 'yellow',
          standingMemo: '対象2の継続メモ',
          projectedValues: { x: '破棄' },
          tags: ['破棄'],
          updatedAt: 220,
        },
      ],
      noteDocuments: [],
      noteSettings: [],
      roundsUserSettings: [],
    },
    localStorage: { current_user_id: 'usr_a' },
    counts: {},
  };
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

describe('listImportCandidates', () => {
  it('バックアップの有効なユーザーを列挙し、複数ユーザーを選択可能にする', () => {
    expect(listImportCandidates(jsonOf(makeWorkspaceBackup()))).toEqual([
      { id: 'usr_a', name: '利用者A' },
      { id: 'usr_b', name: '利用者B' },
    ]);
  });

  it('壊れた user row と重複 id を捨てる', () => {
    const backup = makeWorkspaceBackup();
    const stores = backup.stores as Record<string, unknown[]>;
    (stores.users ??= []).push(
      null,
      { id: '', name: '壊れ' },
      { id: 'usr_bad' },
      { id: 'usr_a', name: '重複' },
    );
    expect(listImportCandidates(jsonOf(backup))).toEqual([
      { id: 'usr_a', name: '利用者A' },
      { id: 'usr_b', name: '利用者B' },
    ]);
  });
});

describe('convertWorkspaceBackup', () => {
  it('place 同名を 1 つにまとめ、選択ユーザーの継続メモだけを移行する', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });

    expect(converted.places.map((place) => place.name)).toEqual(['東エリア', '西エリア']);
    const east = converted.places[0];
    expect(east).toBeDefined();

    expect(converted.patients).toHaveLength(3);
    const first = converted.patients.find((patient) => patient.name === 'サンプル対象1');
    const second = converted.patients.find((patient) => patient.name === 'サンプル対象2');
    const third = converted.patients.find((patient) => patient.name === 'サンプル対象3');
    expect(first).toMatchObject({
      name: 'サンプル対象1',
      room: 'A-01',
      placeId: east?.placeId,
      status: STATUS.NONE,
      problems: ['継続課題'],
      sectionTexts: {},
      standingMemo: 'Aの継続メモ',
      tags: [],
      projectedValues: {},
      archivedAt: 777,
      updatedAt: 120,
    });
    expect(second).toMatchObject({
      placeId: east?.placeId,
      standingMemo: '対象2の継続メモ',
    });
    expect(third).toMatchObject({
      placeId: '',
      problems: ['確認事項'],
      standingMemo: '',
    });
    expect(converted.patients.every((patient) => patient.pid.startsWith('pat_'))).toBe(true);
    // 旧「患者ID」(code 概念) は持ち込まない。
    expect(JSON.stringify(converted.patients)).not.toContain('pt_1');
    expect(JSON.stringify(converted.patients)).not.toContain('fixed:x');
    expect(JSON.stringify(converted.patients)).not.toContain('sharedTags');
    // 清書 (confirmedNote) は本体廃止済み。旧バックアップにあっても持ち込まない。
    expect(JSON.stringify(converted.patients)).not.toContain('confirmedNote');
    expect(JSON.stringify(converted.patients)).not.toContain('Aの清書');
  });

  it('ユーザー選択で per-user の継続メモが切り替わる', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_b', {
      nowMs: NOW,
    });
    const first = converted.patients.find((patient) => patient.name === 'サンプル対象1');
    expect(first?.standingMemo).toBe('Bの継続メモ');
    // usr_b の状態が無い対象は master だけを移し、個人メモは空。
    expect(
      converted.patients.find((patient) => patient.name === 'サンプル対象2')?.standingMemo,
    ).toBe('');
  });

  it('RoundsConfig.closingPreset は注記だけにする', () => {
    const converted = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    expect(converted.notes).toEqual(['closingPresetSkipped']);
  });

  it('壊れた patient/state/place row を捨てて有効 row を救う', () => {
    const backup = makeWorkspaceBackup();
    const stores = backup.stores as Record<string, unknown[]>;
    (stores.patients ??= []).push(
      null,
      { patientId: '', name: '壊れ' },
      { patientId: 'pt_bad' },
      { patientId: 'pt_blank', name: '   ' },
      { patientId: 'pt_1', name: '重複' },
    );
    (stores.roundsUserStates ??= []).push(
      { key: 'wrong', userId: 'usr_a', patientId: 'pt_3', standingMemo: '採用しない' },
      null,
    );
    const appSettings = stores.appSettings as Record<string, unknown>[];
    const places = appSettings.find((row) => row.key === 'placesConfig');
    (places?.items as unknown[]).push(null, { placeId: '', name: '壊れ' });

    const converted = convertWorkspaceBackup(jsonOf(backup), 'usr_a', { nowMs: NOW });
    expect(converted.patients).toHaveLength(3);
    expect(converted.places).toHaveLength(2);
    expect(
      converted.patients.find((patient) => patient.name === 'サンプル対象3')?.standingMemo,
    ).toBe('');
  });

  it('未知のユーザー指定を拒否する', () => {
    expect(() =>
      convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_missing', { nowMs: NOW }),
    ).toThrow(WORKSPACE_IMPORT_USER_NOT_FOUND_MSG);
  });
});

describe('workspace backup envelope guard', () => {
  it('壊れた JSON を拒否する', () => {
    expect(() => listImportCandidates('{bad')).toThrow(WORKSPACE_IMPORT_JSON_UNREADABLE_MSG);
  });

  it('暗号化封筒は平文で書き出し直す案内を出して拒否する', () => {
    expect(() =>
      listImportCandidates(
        jsonOf({
          kind: 'HOSPITAL_WORKSPACE_BACKUP_ENC',
          version: 1,
          appId: 'hospital-workspace',
          data: 'E2:...',
        }),
      ),
    ).toThrow(WORKSPACE_IMPORT_ENCRYPTED_MSG);
  });

  it('DB schema v7 以外は単発変換の対象外として拒否する', () => {
    const backup = { ...makeWorkspaceBackup(), schemaVersion: 6 };
    expect(() => listImportCandidates(jsonOf(backup))).toThrow(workspaceImportSchemaMismatchMsg(6));
  });
});

describe('prepareWorkspaceImportAppend', () => {
  it('既存データを含めず、incoming 側だけを返す（変更しない）', () => {
    const incoming = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    const current = {
      places: [{ placeId: 'plc_existing', name: '既存' }],
      patients: [
        {
          ...(incoming.patients[0] as (typeof incoming.patients)[number]),
          pid: 'pat_existing',
          placeId: '',
        },
      ],
    };

    const prepared = prepareWorkspaceImportAppend(incoming, current);
    expect(prepared.places).toEqual(incoming.places);
    expect(prepared.patients).toEqual(incoming.patients);
  });

  it('ID衝突と取り込み外 place への参照を拒否する', () => {
    const incoming = convertWorkspaceBackup(jsonOf(makeWorkspaceBackup()), 'usr_a', {
      nowMs: NOW,
    });
    expect(() =>
      prepareWorkspaceImportAppend(incoming, {
        places: [incoming.places[0] as (typeof incoming.places)[number]],
        patients: [],
      }),
    ).toThrow('import id collision');

    const broken = {
      ...incoming,
      patients: incoming.patients.map((patient, index) =>
        index === 0 ? { ...patient, placeId: 'plc_missing' } : patient,
      ),
    };
    expect(() => prepareWorkspaceImportAppend(broken, { places: [], patients: [] })).toThrow(
      'import place reference is invalid',
    );
  });
});
