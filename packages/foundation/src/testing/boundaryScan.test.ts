// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanBoundary } from './boundaryScan';

function withFixture(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-scan-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('testing/boundaryScan', () => {
  it('禁止パターンを含むファイルを列挙する (コメント内も意図的にヒット)', () => {
    withFixture((dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'ok.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'sub', 'bad.ts'), '// localLlm という語はコメントでも弾く\n');
      const offenders = scanBoundary({ dir, forbidden: [/\blocalLlm\b/] });
      expect(offenders).toHaveLength(1);
      expect(offenders[0]).toContain('bad.ts');
    });
  });

  it('テストファイルは既定で除外・違反ゼロなら空配列', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'guard.test.ts'), 'const x = "localLlm";\n');
      writeFileSync(join(dir, 'clean.tsx'), 'export const b = 2;\n');
      expect(scanBoundary({ dir, forbidden: [/\blocalLlm\b/] })).toEqual([]);
    });
  });

  it('includeFile / excludeFile を差し替えられる', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'a.mjs'), 'fetch("x");\n');
      const offenders = scanBoundary({
        dir,
        forbidden: [/\bfetch\s*\(/],
        includeFile: (p) => p.endsWith('.mjs'),
        excludeFile: () => false,
      });
      expect(offenders).toHaveLength(1);
    });
  });
});
