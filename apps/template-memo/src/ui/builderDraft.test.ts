import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBuilderDraft,
  clearBuilderResponse,
  createBuilderRequest,
  getBuilderDraft,
  newBuilderSource,
  rememberBuilderResponse,
  saveBuilderResponse,
  saveBuilderSources,
} from './builderDraft';

describe('builderDraft', () => {
  beforeEach(clearBuilderDraft);

  it('同じ文章の保存では依頼を維持し、編集すると依頼を失効させる', () => {
    const source = newBuilderSource('完成文章');
    saveBuilderSources([source]);
    const requestId = createBuilderRequest();

    saveBuilderSources([{ ...source }]);
    expect(getBuilderDraft().requestId).toBe(requestId);

    saveBuilderSources([{ ...source, text: '修正版' }]);
    expect(getBuilderDraft().requestId).toBeNull();
  });

  it('返答だけのクリアは文章と依頼を維持する', () => {
    saveBuilderSources([newBuilderSource('完成文章')]);
    const requestId = createBuilderRequest();
    rememberBuilderResponse('返答');

    clearBuilderResponse();

    expect(getBuilderDraft()).toMatchObject({
      requestId,
      responseText: '',
      parsed: null,
    });
    expect(getBuilderDraft().sources).toHaveLength(1);
  });

  it('貼り付け本文を書き換えたら解析結果を捨てる（未解析の本文で「解析済み」にしない）', () => {
    saveBuilderSources([newBuilderSource('完成文章')]);
    const requestId = createBuilderRequest();
    const parsed = {
      candidate: {
        requestId,
        frame: { name: 'F', sections: [] },
        formats: [],
        template: {
          name: 'T',
          includeProblems: false,
          includeHandover: false,
          placements: [],
        },
        aiWarnings: [],
      },
      warnings: [],
    };
    saveBuilderResponse('返答A', parsed);
    expect(getBuilderDraft().parsed).not.toBeNull();

    // 解析を押さずに本文だけ差し替える → 前の候補は無効。
    rememberBuilderResponse('返答B');
    expect(getBuilderDraft()).toMatchObject({ responseText: '返答B', parsed: null });

    // 同じ本文の再入力では捨てない（入力のたびに壊さない）。
    saveBuilderResponse('返答B', parsed);
    rememberBuilderResponse('返答B');
    expect(getBuilderDraft().parsed).not.toBeNull();
  });
});
