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
import { buildRoundPreset, type Template } from './template';
import type { AppSettings, Group, Subject } from './types';

const NOW = 1_753_000_000_000;

// ── フィクスチャ ──

function makeGroup(id: string, name: string, sortOrder = 1): Group {
  return { id, name, sortOrder };
}

function makeSubject(over: Partial<Subject> = {}): Subject {
  return {
    id: 'sub_a',
    name: '対象A',
    code: 'A-001',
    location: '101',
    groupId: null,
    sortOrder: 1,
    status: 'yellow',
    problems: ['発熱\n経過観察中'],
    handover: '申し送りメモ',
    sectionText: { sec_1: '本文テキスト' },
    formValues: {
      grp_1: {
        itm_1: { value: '120/80' },
        itm_2: { value: '96', note: 'O2 2L' },
        itm_3: 'legacy 文字列',
      },
    },
    confirmedNote: '清書テキスト',
    tagIds: ['tag_1'],
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function makeSettings(activeTemplateId: string): AppSettings {
  return {
    key: 'app',
    activeTemplateId,
    tags: [{ id: 'tag_1', name: '要注意', sortOrder: 1 }],
    snippets: [{ id: 'snp_1', label: '採血', body: '採血: __' }],
    newlineMode: 'lf',
    round: { startedAt: NOW - 1000, endedAt: null },
    onboardingDone: true,
    updatedAt: NOW,
  };
}

interface Fixture {
  settings: AppSettings;
  groups: Group[];
  subjects: Subject[];
  templates: Template[];
}

function makeFixture(): Fixture {
  const template = buildRoundPreset(NOW);
  const groups = [makeGroup('grp_a', '第1グループ')];
  const subjects = [makeSubject({ groupId: 'grp_a' })];
  return { settings: makeSettings(template.id), groups, subjects, templates: [template] };
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

  it('build→parse で settings/groups/subjects/templates が一致する', () => {
    const data = makeFixture();
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.settings).toEqual(data.settings);
    expect(parsed.groups).toEqual(data.groups);
    expect(parsed.subjects).toEqual(data.subjects);
    expect(parsed.templates).toEqual(data.templates);
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

  it('schemaVersion 不一致を拒否する（migration しない）', () => {
    const json = envelopeWith({ schemaVersion: SCHEMA_VERSION + 1 });
    expect(() => parseBackupJson(json)).toThrow(backupSchemaMismatchMsg(SCHEMA_VERSION + 1));
  });

  it('templates が配列でなければ拒否する', () => {
    const json = envelopeWith({ templates: 'broken' });
    expect(() => parseBackupJson(json)).toThrow(backupFieldBrokenMsg('templates'));
  });

  it('templates が全滅（全 row 壊れ）なら拒否する', () => {
    const json = envelopeWith({ templates: [{}, { sections: [] }, null] });
    expect(() => parseBackupJson(json)).toThrow(BACKUP_NO_TEMPLATES_MSG);
  });

  it('subjects が配列でなければ拒否する（黙って空にしない）', () => {
    const json = envelopeWith({ subjects: { broken: true } });
    expect(() => parseBackupJson(json)).toThrow(backupFieldBrokenMsg('subjects'));
  });
});

// ── 壊れ row の drop と生存 ──

describe('parseBackupJson の防御的正規化', () => {
  it('壊れた subject row は捨て、正常 row は生き残る', () => {
    const good = makeSubject();
    const json = envelopeWith({
      subjects: [
        good,
        null, // object ですらない
        'garbage', // 文字列
        { id: 123, name: 'id が数値' }, // id 型不正
        { id: 'sub_bad', name: 42 }, // name 型不正
      ],
    });
    const parsed = parseBackupJson(json);
    expect(parsed.subjects).toEqual([good]);
  });

  it('subject の欄単位の型不正は既定値へ倒して row を救う', () => {
    const json = envelopeWith({
      subjects: [
        {
          id: 'sub_dirty',
          name: '欄が汚れた対象',
          status: 'purple', // 不正ステータス
          problems: 'not-array',
          sectionText: 5,
          formValues: [1, 2], // 配列は plain object でない
          tagIds: { a: 1 },
          archivedAt: 'yesterday',
        },
      ],
    });
    const parsed = parseBackupJson(json);
    expect(parsed.subjects).toHaveLength(1);
    const s = parsed.subjects[0]!;
    expect(s.status).toBe('none');
    expect(s.problems).toEqual([]);
    expect(s.sectionText).toEqual({});
    expect(s.formValues).toEqual({});
    expect(s.tagIds).toEqual([]);
    expect(s.archivedAt).toBeNull();
  });

  it('壊れた group row は捨て、正常 row は生き残る', () => {
    const good = makeGroup('grp_a', '第1グループ');
    const json = envelopeWith({
      groups: [good, { id: '', name: 'id 空' }, { name: 'id なし' }, 7],
      subjects: [],
    });
    const parsed = parseBackupJson(json);
    expect(parsed.groups).toEqual([good]);
  });

  it('settings が壊れていても既定値で復元できる', () => {
    const json = envelopeWith({ settings: 'broken' });
    const parsed = parseBackupJson(json);
    expect(parsed.settings.key).toBe('app');
    expect(parsed.settings.activeTemplateId).toBe(parsed.templates[0]!.id);
    expect(parsed.settings.tags).toEqual([]);
    expect(parsed.settings.snippets).toEqual([]);
    expect(parsed.settings.newlineMode).toBe('crlf');
    expect(parsed.settings.round).toBeNull();
    expect(parsed.settings.onboardingDone).toBe(false);
  });
});

// ── 参照の付け替え ──

describe('parseBackupJson の参照整合', () => {
  it('activeTemplateId が templates に無ければ先頭 template へ付け替える', () => {
    const data = makeFixture();
    data.settings = { ...data.settings, activeTemplateId: 'tpl_missing' };
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.settings.activeTemplateId).toBe(data.templates[0]!.id);
  });

  it('Subject.groupId が groups に無ければ null（未分類）へ倒す', () => {
    const data = makeFixture();
    data.subjects = [makeSubject({ groupId: 'grp_missing' })];
    const parsed = parseBackupJson(buildBackupJson(data, NOW));
    expect(parsed.subjects[0]!.groupId).toBeNull();
  });
});
