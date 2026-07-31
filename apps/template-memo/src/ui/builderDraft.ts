/*
 * テンプレート作成アシストの一時ドラフト。
 * 実データを含みうるため module-scope のメモリだけに置き、永続化・バックアップ・QRへ渡さない。
 */

import { newId } from '../data/constants';
import type { BuilderCandidate, BuilderWarning } from '../domain/templateBuilder';

export interface BuilderSourceDraft {
  id: string;
  text: string;
}

export interface ParsedBuilderDraft {
  candidate: BuilderCandidate;
  warnings: BuilderWarning[];
}

export interface BuilderDraft {
  sources: BuilderSourceDraft[];
  requestId: string | null;
  responseText: string;
  parsed: ParsedBuilderDraft | null;
}

function emptyDraft(): BuilderDraft {
  return { sources: [], requestId: null, responseText: '', parsed: null };
}

let draft = emptyDraft();

export function getBuilderDraft(): BuilderDraft {
  return draft;
}

export function newBuilderSource(text = ''): BuilderSourceDraft {
  return { id: newId('src'), text };
}

export function saveBuilderSources(sources: readonly BuilderSourceDraft[]): void {
  const next = sources.map((source) => ({ ...source }));
  const changed =
    next.length !== draft.sources.length ||
    next.some(
      (source, index) =>
        source.id !== draft.sources[index]?.id || source.text !== draft.sources[index]?.text,
    );
  if (!changed) return;
  draft = { ...draft, sources: next, requestId: null };
}

export function createBuilderRequest(): string {
  const requestId = newId('req');
  draft = { ...draft, requestId };
  return requestId;
}

export function saveBuilderResponse(responseText: string, parsed: ParsedBuilderDraft): void {
  draft = { ...draft, responseText, parsed };
}

export function rememberBuilderResponse(responseText: string): void {
  draft = { ...draft, responseText };
}

export function clearBuilderResponse(): void {
  draft = { ...draft, responseText: '', parsed: null };
}

export function clearBuilderDraft(): void {
  draft = emptyDraft();
}
