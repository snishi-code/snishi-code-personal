/*
 * 転記用 QR 本文（domain/payload.ts）のテスト。
 * 本文の中身は composePresetClean 側（template.test.ts の golden）が固定するので、
 * ここでは「テンプレートが無いときに何を出すか」の fail-soft 契約だけを固定する。
 */
import { describe, expect, it } from 'vitest';
import { buildTabPayload } from './payload';
import type { Template } from './template';
import { makeDefaultPatient } from './normalize';

function patientWithText(): ReturnType<typeof makeDefaultPatient> {
  return { ...makeDefaultPatient(), sectionTexts: { 'sec-s': '書いた本文' } };
}

const template: Template = {
  id: 'tpl',
  name: 'テスト',
  includeProblems: false,
  includeHandover: false,
  sections: [{ id: 'sec-s', title: '(S)', freeText: true, formats: [] }],
  updatedAt: 0,
};

describe('buildTabPayload', () => {
  it('テンプレートが無ければ空文字（自由本文は場所の持ち物なので受け皿が無い）', () => {
    expect(buildTabPayload(patientWithText(), null)).toBe('');
    expect(buildTabPayload(patientWithText(), undefined)).toBe('');
  });

  it('対象が無ければ空文字', () => {
    expect(buildTabPayload(null, template)).toBe('');
  });

  it('テンプレートがあれば定型清書を出す', () => {
    expect(buildTabPayload(patientWithText(), template)).toBe('(S)\n書いた本文');
  });
});
