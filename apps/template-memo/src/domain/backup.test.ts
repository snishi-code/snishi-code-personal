/*
 * JSON バックアップ（domain/backup.ts）のテスト。
 * roundtrip / 封筒不一致の fail-closed 拒否 / 壊れ row の drop と生存 / 参照付け替えを検証する。
 */
import { describe, expect, it } from 'vitest';
import { APP_ID, BACKUP_KIND, SCHEMA_VERSION } from '../data/constants';
import {
  BACKUP_JSON_UNREADABLE_MSG,
  BACKUP_MALFORMED_MSG,
  BACKUP_NO_TEMPLATES_MSG,
  BACKUP_WRONG_APP_MSG,
  BACKUP_WRONG_KIND_MSG,
  backupFieldBrokenMsg,
  backupSchemaMismatchMsg,
  buildBackupJson,
  parseBackupJson,
} from './backup';
import type { Format, Frame, TemplateDef } from './entities';
import { buildRoundPreset } from './presets';
import type { AppSettings, Patient, PlaceDef } from './types';

const NOW = 1_753_000_000_000;

// ── フィクスチャ ──

function makePlace(placeId: string, name: string, templateId = 'tpl_soap'): PlaceDef {
  return { placeId, name, templateId };
}

function makePatient(over: Partial<Patient> = {}): Patient {
  return {
    pid: 'pat_a',
    name: '対象A',
    room: '101',
    placeId: '',
    status: 'yellow',
    tags: ['要注意'],
    problems: ['発熱\n経過観察中'],
    sectionTexts: { sec_s: '本人の訴え', sec_o: '所見の本文' },
    standingMemo: '継続メモ本文',
    templateId: 'tpl_soap',
    projectedValues: {
      plm_1: {
        itm_1: { value: '120/80' },
        itm_2: { value: '96', note: 'O2 2L' },
        itm_3: { value: '明らかなラ音なし', source: 'preset' },
      },
    },
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  };
}

function makeSettings(defaultTemplateId: string): AppSettings {
  return {
    key: 'app',
    defaultTemplateId,
    tags: [{ name: '要注意', color: 'amber' }],
    newlineMode: 'lf',
    updatedAt: NOW,
  };
}

interface Fixture {
  settings: AppSettings;
  places: PlaceDef[];
  patients: Patient[];
  frames: Frame[];
  formats: Format[];
  templates: TemplateDef[];
}

function makeFixture(): Fixture {
  const preset = buildRoundPreset(NOW);
  const decision: Format = {
    id: 'fmt_decision',
    name: '判定',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    items: [
      {
        id: 'itm_select',
        label: '方針',
        kind: 'select',
        options: ['経過観察', '精査'],
      },
    ],
  };
  preset.formats.push(decision);
  preset.template.placements.push({
    id: 'plm_menu',
    sectionId: preset.frame.sections[1]!.id,
    formatId: decision.id,
    display: 'menu',
  });
  const places = [makePlace('plc_a', '第1グループ', preset.template.id)];
  const patients = [makePatient({ placeId: 'plc_a', templateId: preset.template.id })];
  return {
    settings: makeSettings(preset.template.id),
    places,
    patients,
    frames: [preset.frame],
    formats: preset.formats,
    templates: [preset.template],
  };
}

/** 正常な封筒を組んでから一部を差し替えた JSON を作る（拒否系テスト用）。 */
function envelopeWith(patch: Record<string, unknown>): string {
  const base = JSON.parse(buildBackupJson(makeFixture(), NOW)) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...patch });
}

// ── roundtrip ──

describe('buildBackupJson → parseBackupJson roundtrip', () => {
  it('封筒に kind/appId/schemaVersion/exportedAt が入る', () => {
    const json = buildBackupJson(makeFixture(), NOW);
    const env = JSON.parse(json) as Record<string, unknown>;
    expect(env.kind).toBe(BACKUP_KIND);
    expect(env.appId).toBe(APP_ID);
    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.exportedAt).toBe(new Date(NOW).toISOString());
  });

  it('build→parse で settings/places/patients/frames/formats/templates が一致する', () => {
    const data = makeFixture();
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.settings).toEqual(data.settings);
    expect(parsed.places).toEqual(data.places);
    expect(parsed.patients).toEqual(data.patients);
    expect(parsed.frames).toEqual(data.frames);
    expect(parsed.formats).toEqual(data.formats);
    expect(parsed.templates).toEqual(data.templates);
  });

  it('v5 の roundtrip で場所ごとの自由本文が保持される', () => {
    const data = makeFixture();
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.patients[0]!.sectionTexts).toEqual({
      sec_s: '本人の訴え',
      sec_o: '所見の本文',
    });
  });
});

// ── fail-closed（封筒不一致の拒否） ──

describe('parseBackupJson の fail-closed 拒否', () => {
  it('JSON でないテキストを拒否する', () => {
    expect(() => parseBackupJson('{ this is not json')).toThrow(BACKUP_JSON_UNREADABLE_MSG);
  });

  it('object でない JSON を拒否する', () => {
    expect(() => parseBackupJson('[1,2,3]')).toThrow(BACKUP_MALFORMED_MSG);
  });

  it('kind 不一致（別種の封筒）を拒否する', () => {
    const json = envelopeWith({ kind: 'HOSPITAL_WORKSPACE_BACKUP' });
    expect(() => parseBackupJson(json)).toThrow(BACKUP_WRONG_KIND_MSG);
  });

  it('appId 不一致（別アプリの封筒）を拒否する', () => {
    const json = envelopeWith({ appId: 'snishi-code.simple-ledger' });
    expect(() => parseBackupJson(json)).toThrow(BACKUP_WRONG_APP_MSG);
  });

  it('schemaVersion 不一致を拒否する（migration しない・旧 v1〜v4 封筒も拒否）', () => {
    const newer = envelopeWith({ schemaVersion: SCHEMA_VERSION + 1 });
    expect(() => parseBackupJson(newer)).toThrow(backupSchemaMismatchMsg(SCHEMA_VERSION + 1));
    for (const old of [1, 2, 3, 4]) {
      const json = envelopeWith({ schemaVersion: old });
      expect(() => parseBackupJson(json)).toThrow(backupSchemaMismatchMsg(old));
    }
  });

  it('templates が配列でなければ拒否する', () => {
    const json = envelopeWith({ templates: 'broken' });
    expect(() => parseBackupJson(json)).toThrow(backupFieldBrokenMsg('templates'));
  });

  it('templates が全滅（全 row 壊れ）なら拒否する', () => {
    const json = envelopeWith({ templates: [{}, { sections: [] }, null] });
    expect(() => parseBackupJson(json)).toThrow(BACKUP_NO_TEMPLATES_MSG);
  });

  it('patients が配列でなければ拒否する（黙って空にしない）', () => {
    const json = envelopeWith({ patients: { broken: true } });
    expect(() => parseBackupJson(json)).toThrow(backupFieldBrokenMsg('patients'));
  });
});

// ── 壊れ row の drop と生存 ──

describe('parseBackupJson の防御的正規化', () => {
  it('壊れた patient row は捨て、正常 row は生き残る', () => {
    const good = makePatient({ placeId: 'plc_a' });
    const json = envelopeWith({
      patients: [
        good,
        null, // object ですらない
        'garbage', // 文字列
        { pid: 123, name: 'pid が数値' }, // pid 型不正
        { pid: 'pat_bad', name: 42 }, // name 型不正
      ],
    });
    const parsed = parseBackupJson(json);
    // good の templateId 'tpl_soap' は封筒の templates に無いので、
    // 所属グループのデフォルト (= 実在 template) へ倒した形で生き残る。
    expect(parsed.patients).toEqual([{ ...good, templateId: parsed.places[0]!.templateId }]);
  });

  it('patient の欄単位の型不正は既定値へ倒して row を救う', () => {
    const json = envelopeWith({
      patients: [
        {
          pid: 'pat_dirty',
          name: '欄が汚れた対象',
          status: 'purple', // 不正ステータス
          problems: 'not-array',
          tags: { a: 1 },
          projectedValues: [1, 2], // 配列は plain object でない
          sectionTexts: { ok: '生きる', num: 7, arr: ['x'], nested: { a: 'b' } },
          archivedAt: 'yesterday',
        },
      ],
    });
    const parsed = parseBackupJson(json);
    expect(parsed.patients).toHaveLength(1);
    const s = parsed.patients[0]!;
    expect(s.status).toBe('none');
    expect(s.problems).toEqual([]);
    expect(s.tags).toEqual([]);
    expect(s.projectedValues).toEqual({});
    // string 値のエントリだけを残す（非文字列・配列・入れ子は捨てる）。
    expect(s.sectionTexts).toEqual({ ok: '生きる' });
    expect(s.archivedAt).toBeNull();
  });

  it('sectionTexts が object でなければ空にする', () => {
    const json = envelopeWith({
      patients: [{ pid: 'pat_x', name: '対象X', sectionTexts: 'broken' }],
    });
    expect(parseBackupJson(json).patients[0]!.sectionTexts).toEqual({});
  });

  it('壊れた place row は捨て、正常 row は生き残る（迷子 templateId は先頭 template へ）', () => {
    const good = makePlace('plc_a', '第1グループ', 'tpl_missing');
    const json = envelopeWith({
      places: [good, { placeId: '', name: 'placeId 空' }, { name: 'placeId なし' }, 7],
      patients: [],
    });
    const parsed = parseBackupJson(json);
    expect(parsed.places).toEqual([
      { ...good, templateId: parsed.templates[0]!.id }, // 実在しない参照は残さない
    ]);
  });

  it('settings が壊れていても既定値で復元できる', () => {
    const json = envelopeWith({ settings: 'broken' });
    const parsed = parseBackupJson(json);
    expect(parsed.settings.key).toBe('app');
    expect(parsed.settings.defaultTemplateId).toBe(parsed.templates[0]!.id);
    expect(parsed.settings.tags).toEqual([]);
    expect(parsed.settings.newlineMode).toBe('crlf');
  });
});

// ── 参照の付け替え ──

describe('parseBackupJson の参照整合', () => {
  it('defaultTemplateId が templates に無ければ先頭 template へ付け替える', () => {
    const data = makeFixture();
    data.settings = { ...data.settings, defaultTemplateId: 'tpl_missing' };
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.settings.defaultTemplateId).toBe(data.templates[0]!.id);
  });

  it('Patient.placeId が places に無ければ先頭 place へ倒す', () => {
    const data = makeFixture();
    data.patients = [makePatient({ placeId: 'plc_missing' })];
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.patients[0]!.placeId).toBe('plc_a');
  });
});
