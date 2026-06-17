import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createImportPipeline, type ImportPipelineConfig } from './importPipeline';

const pkgSchema = z.object({
  appId: z.string(),
  schemaVersion: z.number(),
  exportedAt: z.string(),
  revision: z.number().optional(),
  items: z.array(z.string()),
});
type Pkg = z.infer<typeof pkgSchema>;

function validRaw(over: Partial<Pkg> = {}): string {
  return JSON.stringify({
    appId: 'test-app',
    schemaVersion: 2,
    exportedAt: '2026-06-11T00:00:00Z',
    revision: 5,
    items: ['a'],
    ...over,
  });
}

function setup(over: Partial<ImportPipelineConfig<Pkg>> = {}) {
  const calls: string[] = [];
  const cfg: ImportPipelineConfig<Pkg> = {
    appId: 'test-app',
    currentSchemaVersion: 2,
    migrate: (data, fromVersion) =>
      fromVersion === 1
        ? { ok: true, data: { ...(data as object), schemaVersion: 2 } }
        : { ok: false, reason: `unsupported version ${fromVersion}` },
    validate: (data) => {
      const res = pkgSchema.safeParse(data);
      if (res.success) return { ok: true, pkg: res.data };
      const first = res.error.issues[0];
      return { ok: false, detail: `${first?.path.join('.') ?? ''}: ${first?.message ?? ''}` };
    },
    getCurrentRevision: async () => {
      calls.push('revision');
      return 5;
    },
    snapshotBefore: async () => {
      calls.push('snapshot');
    },
    replaceAll: async () => {
      calls.push('replace');
    },
    ...over,
  };
  return { pipeline: createImportPipeline<Pkg>(cfg), calls };
}

describe('exchange/importPipeline', () => {
  it('ok: 7 段階を通過し、snapshot → replace の順で実行される', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(validRaw());
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.pkg.items).toEqual(['a']);
    expect(calls).toEqual(['revision', 'snapshot', 'replace']);
  });

  it('parse-error: JSON でないテキスト', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText('not json {');
    expect(res.kind).toBe('parse-error');
    expect(calls).toEqual([]);
  });

  it('validation-error: 封筒(appId / schemaVersion)が無い', async () => {
    const { pipeline } = setup();
    const res = await pipeline.importFromJsonText('{}');
    expect(res.kind).toBe('validation-error');
  });

  it('not-our-file: appId 不一致', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(validRaw({ appId: 'other-app' }));
    expect(res.kind).toBe('not-our-file');
    if (res.kind === 'not-our-file') expect(res.detail).toContain('other-app');
    expect(calls).toEqual([]);
  });

  it('unsupported-version: migration が失敗する版は fail-closed', async () => {
    const { pipeline } = setup();
    const res = await pipeline.importFromJsonText(validRaw({ schemaVersion: 99 }));
    expect(res).toEqual({ kind: 'unsupported-version', detail: 'unsupported version 99' });
  });

  it('旧版は migration を通って ok になる', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(validRaw({ schemaVersion: 1 }));
    expect(res.kind).toBe('ok');
    expect(calls).toContain('replace');
  });

  it('validation-error: スキーマ完全検証で弾かれる(detail に場所を含む)', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(
      validRaw({ items: 'broken' as unknown as string[] }),
    );
    expect(res.kind).toBe('validation-error');
    if (res.kind === 'validation-error') expect(res.detail).toContain('items');
    expect(calls).toEqual([]);
  });

  it('revision-conflict: revision 不一致は自動上書きせず双方の値を返す', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(validRaw({ revision: 3 }));
    expect(res.kind).toBe('revision-conflict');
    if (res.kind === 'revision-conflict') {
      expect(res.localRevision).toBe(5);
      expect(res.importRevision).toBe(3);
    }
    expect(calls).toEqual(['revision']); // snapshot / replace に進まない
  });

  it('revision-conflict: force=true で明示承認すれば通る', async () => {
    const { pipeline, calls } = setup();
    const res = await pipeline.importFromJsonText(validRaw({ revision: 3 }), { force: true });
    expect(res.kind).toBe('ok');
    expect(calls).toEqual(['snapshot', 'replace']);
  });

  it('revision を使わないアプリ(null)は衝突チェックをスキップする', async () => {
    const { pipeline } = setup({ getCurrentRevision: async () => null });
    const res = await pipeline.importFromJsonText(validRaw({ revision: 3 }));
    expect(res.kind).toBe('ok');
  });

  it('storage-error: replaceAll の throw を成功扱いにしない', async () => {
    const { pipeline } = setup({
      replaceAll: async () => {
        throw new Error('disk full');
      },
    });
    const res = await pipeline.importFromJsonText(validRaw());
    expect(res).toEqual({ kind: 'storage-error', detail: 'disk full' });
  });

  it('storage-error: snapshotBefore が失敗したら置換に進まない', async () => {
    const { pipeline, calls } = setup({
      snapshotBefore: async () => {
        throw new Error('snapshot failed');
      },
    });
    const res = await pipeline.importFromJsonText(validRaw());
    expect(res).toEqual({ kind: 'storage-error', detail: 'snapshot failed' });
    expect(calls).not.toContain('replace');
  });
});
