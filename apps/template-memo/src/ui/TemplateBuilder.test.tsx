/*
 * 候補確認画面が「既存部品の再利用」を明示するか。
 * 判定そのものは domain/entityReuse.test.ts と data/store.test.ts で固定しているので、
 * ここでは計画が画面へ出ていること（登録前に利用者が気づけること）だけを見る。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import type { Format, Frame } from '../domain/entities';
import type { BuilderCandidate } from '../domain/templateBuilder';
import type { AppRuntime } from './appRuntime';
import { TemplateBuilderPreview } from './TemplateBuilder';

afterEach(cleanup);

const readingsItems = [
  { label: '温度', kind: 'number' as const, unit: '℃' },
  { label: '運転モード', kind: 'select' as const, options: ['自動', '手動'] },
];

function candidateOf(formats: BuilderCandidate['formats']): BuilderCandidate {
  return {
    requestId: 'req-1',
    frame: {
      name: '設備点検',
      sections: [
        { key: 'sec_summary', title: '【点検概要】', freeText: true },
        { key: 'sec_readings', title: '【測定値】', freeText: false },
      ],
    },
    formats,
    template: {
      name: '設備点検メモ',
      includeProblems: false,
      includeHandover: false,
      placements: formats.map((format) => ({
        sectionKey: 'sec_readings',
        formatKey: format.key,
        display: 'always' as const,
      })),
    },
    aiWarnings: [],
  };
}

const readingsCandidate: BuilderCandidate['formats'][number] = {
  key: 'fmt_readings',
  name: '測定結果',
  joiner: ', ',
  labelSep: ' ',
  items: readingsItems,
};

/** readingsCandidate と構造が一致する既存フォーマット（名前だけ違う）。 */
function existingReadings(name: string): Format {
  return {
    id: 'existing-fmt',
    name,
    joiner: ', ',
    labelSep: ' ',
    titleWrap: '',
    items: [
      { id: 'existing-itm-1', label: '温度', kind: 'number', unit: '℃' },
      { id: 'existing-itm-2', label: '運転モード', kind: 'select', options: ['自動', '手動'] },
    ],
  };
}

const existingFrame: Frame = {
  id: 'existing-frm',
  name: '点検フレーム（改名済み）',
  sections: [
    { id: 'existing-sec-1', title: '【点検概要】', freeText: true },
    { id: 'existing-sec-2', title: '【測定値】', freeText: false },
  ],
};

function renderPreview(
  options: { frames?: Frame[]; formats?: Format[] },
  candidate: BuilderCandidate,
) {
  const runtime = {
    store: {
      getFrames: () => options.frames ?? [],
      getFormats: () => options.formats ?? [],
    },
    bump: () => {},
  } as unknown as AppRuntime;
  render(
    <ToastProvider>
      <TemplateBuilderPreview
        runtime={runtime}
        candidate={candidate}
        warnings={[]}
        onDone={() => {}}
      />
    </ToastProvider>,
  );
}

describe('候補確認画面の再利用表示', () => {
  it('構造一致する既存フォーマットは既存側の名前つきで「再利用」と出す', () => {
    renderPreview(
      { formats: [existingReadings('バイタル (2)')] },
      candidateOf([readingsCandidate]),
    );
    expect(screen.getByText('既存『バイタル (2)』を再利用')).toBeTruthy();
  });

  it('構造一致する既存フレームも「再利用」と出す', () => {
    renderPreview({ frames: [existingFrame] }, candidateOf([readingsCandidate]));
    expect(screen.getByText('既存『点検フレーム（改名済み）』を再利用')).toBeTruthy();
  });

  it('バンドル内の名前違い・同構造は統合先と統合元の両方に注記を出す', () => {
    renderPreview(
      {},
      candidateOf([readingsCandidate, { ...readingsCandidate, key: 'fmt_twin', name: '測定値' }]),
    );
    expect(screen.getByText('同じ内容の候補 2 件を統合')).toBeTruthy();
    expect(screen.getByText('『測定結果』と同じ内容のため統合')).toBeTruthy();
  });

  it('一致する既存が無ければ再利用の注記を出さない', () => {
    renderPreview({}, candidateOf([readingsCandidate]));
    expect(screen.queryByText(/再利用/)).toBeNull();
    expect(screen.queryByText(/統合/)).toBeNull();
  });
});
