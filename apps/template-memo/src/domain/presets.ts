/*
 * 初回 seed と「プリセットから追加」で使う独立エンティティ一式。
 * 呼び出すたびに全 ID を採番し、既存部品との暗黙共有や端末間衝突を作らない。
 */

import { newId } from '../data/constants';
import type { Format, Frame, TemplateDef } from './entities';

export interface TemplatePresetBundle {
  frame: Frame;
  formats: Format[];
  template: TemplateDef;
}

export function buildRoundPreset(nowMs: number): TemplatePresetBundle {
  const sectionS = newId('sec');
  const sectionO = newId('sec');
  const sectionA = newId('sec');
  const sectionP = newId('sec');
  const frame: Frame = {
    id: newId('frm'),
    name: 'SOAP',
    sections: [
      { id: sectionS, title: '(S)', freeText: true, normal: '変わりない' },
      { id: sectionO, title: '(O)', freeText: true },
      { id: sectionA, title: '(A)', freeText: true, normal: '著変なし' },
      { id: sectionP, title: '(P)', freeText: true, normal: '現行加療継続' },
    ],
  };

  // 実運用で固まった形。1 行に並ぶ順（測って書く順）に項目を置き、単位は項目側が持つ。
  // 見出しは出さない: ラベル列があるので何の値かは行を見れば分かり、縦を詰められる。
  const vitals: Format = {
    id: newId('fmt'),
    name: 'バイタル',
    joiner: ', ',
    labelSep: ' ',
    titleWrap: '',
    showName: false,
    items: [
      { id: newId('itm'), label: 'SpO2', kind: 'text', unit: '%' },
      { id: newId('itm'), label: 'BT', kind: 'text', unit: '℃' },
      { id: newId('itm'), label: 'BP', kind: 'text', unit: 'mmHg' },
      { id: newId('itm'), label: 'HR', kind: 'text' },
      { id: newId('itm'), label: '食事', kind: 'text', normal: '問題なし' },
      { id: newId('itm'), label: '尿', kind: 'text', unit: 'mL' },
      { id: newId('itm'), label: 'Glu', kind: 'text', unit: 'mg/dL' },
    ],
  };
  const physical: Format = {
    id: newId('fmt'),
    name: '身体所見',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    showName: false,
    items: [
      { id: newId('itm'), label: '肺音', kind: 'text', normal: '明らかなラ音なし' },
      { id: newId('itm'), label: '腸音', kind: 'text', normal: '正常' },
      { id: newId('itm'), label: '腹部', kind: 'text', normal: '平坦軟、圧痛なし' },
      { id: newId('itm'), label: '下腿浮腫', kind: 'text', normal: 'なし' },
    ],
  };
  // 配置は持たせない再利用部品。必要になった場所へ利用者が置く。
  const labs: Format = {
    id: newId('fmt'),
    name: '検査所見',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    items: [
      { id: newId('itm'), label: '採血', kind: 'text' },
      { id: newId('itm'), label: '胸部Xp', kind: 'text' },
      { id: newId('itm'), label: 'CT', kind: 'text' },
    ],
  };
  const formats = [vitals, physical, labs];

  const template: TemplateDef = {
    id: newId('tpl'),
    name: '回診',
    frameId: frame.id,
    includeProblems: true,
    includeHandover: true,
    // (O) にバイタルと身体所見だけを展開で置く。検査所見は未配置で残す。
    placements: [vitals, physical].map((format) => ({
      id: newId('plm'),
      sectionId: sectionO,
      formatId: format.id,
      display: 'always' as const,
    })),
    updatedAt: nowMs,
  };
  return { frame, formats, template };
}

export function buildDailyReportPreset(nowMs: number): TemplatePresetBundle {
  const today = newId('sec');
  const frame: Frame = {
    id: newId('frm'),
    name: '日報',
    sections: [
      { id: today, title: '【今日やったこと】', freeText: true },
      {
        id: newId('sec'),
        title: '【課題・気づき】',
        freeText: true,
        normal: '特になし',
      },
      { id: newId('sec'), title: '【明日の予定】', freeText: true },
    ],
  };
  const template: TemplateDef = {
    id: newId('tpl'),
    name: '日報',
    frameId: frame.id,
    includeProblems: false,
    includeHandover: false,
    placements: [],
    updatedAt: nowMs,
  };
  return { frame, formats: [], template };
}
