import { describe, expect, it } from 'vitest';
import { buildExportFileName, buildExportText } from './export';

describe('exchange/export', () => {
  it('buildExportText は整形 JSON を返し roundtrip できる', () => {
    const pkg = { appId: 'x', items: [1, 2] };
    const text = buildExportText(pkg);
    expect(text).toContain('\n  "appId"');
    expect(JSON.parse(text)).toEqual(pkg);
  });

  it('buildExportFileName は prefix_YYYY-MM-DDTHH-mm-ss.json 形式', () => {
    const name = buildExportFileName('ledger', new Date('2026-06-11T03:04:05.678Z'));
    expect(name).toBe('ledger_2026-06-11T03-04-05.json');
  });

  it('buildExportFileName はファイル名に不向きな文字を除去し、空なら export にフォールバック', () => {
    const at = new Date('2026-06-11T03:04:05Z');
    expect(buildExportFileName('my ledger!', at)).toBe('myledger_2026-06-11T03-04-05.json');
    expect(buildExportFileName('!!!', at)).toBe('export_2026-06-11T03-04-05.json');
  });
});
