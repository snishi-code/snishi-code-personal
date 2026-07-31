import { describe, expect, it } from 'vitest';
import { buildBuilderPrompt } from './builderPrompt';
import { BUILDER_EXPECTED_JSON } from './templateBuilder';

function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('buildBuilderPrompt', () => {
  it('ブロック間を空行で区切り、空見本を除き、末尾を改行する', () => {
    const prompt = buildBuilderPrompt(['  見本A  ', '', '見本B'], 'req_test');
    expect(prompt).toContain('### 見本 1\n見本A\n### 見本 2\n見本B');
    expect(prompt).not.toContain('### 見本 3');
    expect(prompt.endsWith('\n')).toBe(true);
    expect(prompt).toContain('"requestId": "req_test"');
  });

  it('区切りとJSON内改行をバックスラッシュ+nの2文字で説明する', () => {
    const prompt = buildBuilderPrompt(['例'], 'req_escape');
    expect(prompt).toContain('joiner は "\\n" / ", "');
    expect(prompt).toContain('改行を表す場合は "\\n" の 2 文字');
    expect(prompt).toContain('"joiner": "\\n"');
  });

  it('期待JSONの正本をrequestIdだけ差し替えて含める', () => {
    const prompt = buildBuilderPrompt(['例'], 'req_contract');
    expect(prompt).toContain(
      BUILDER_EXPECTED_JSON.replace('<依頼文の requestId をそのまま返す>', 'req_contract'),
    );
  });

  it('依頼文全体のgolden fingerprintを固定する', () => {
    const prompt = buildBuilderPrompt(
      ['【概要】\n定期点検を実施', '【概要】\n臨時点検を実施'],
      'req_golden',
    );
    expect({ length: prompt.length, fingerprint: fingerprint(prompt) }).toEqual({
      length: 3690,
      fingerprint: '5f49deca',
    });
  });
});
