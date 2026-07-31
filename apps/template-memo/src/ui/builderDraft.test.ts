import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBuilderDraft,
  clearBuilderResponse,
  createBuilderRequest,
  getBuilderDraft,
  newBuilderSource,
  rememberBuilderResponse,
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
});
