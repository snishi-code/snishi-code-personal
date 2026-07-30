/*
 * template-memo のドメイン型。
 *
 * 系譜: medical 側 hospital-workspace/rounds の「患者・病棟・診察状態」を
 * 単一ユーザー・汎用ラウンド向けに一般化した。内部語は中立
 * （患者→Subject / 病棟→Group / 部屋→location / 患者ID→code）。
 * 医療専用の概念（ユーザー・担当者・AI・記録補助・同期）は持たない。
 */

// ============================
// ステータス（5色・固定意味）
// ============================

/**
 * 対象ステータスの固定意味（UI 色・ラウンドクリアの対象判定はこの意味に従う）:
 *   NONE   白 = 未（未着手）
 *   YELLOW 黄 = 途中（対応中・記載前）
 *   GREEN  緑 = 済（今回の確認・作業が済んだ）
 *   GRAY   灰 = 転記済（清書を出力先へ書き写すところまで済んだ）
 *   BLUE   青 = 特記（新規・要注意など。ラウンド開始でも消えない）
 */
export const STATUS = Object.freeze({
  NONE: 'none',
  YELLOW: 'yellow',
  GREEN: 'green',
  GRAY: 'gray',
  BLUE: 'blue',
} as const);
export type SubjectStatus = (typeof STATUS)[keyof typeof STATUS];

export function isSubjectStatus(v: unknown): v is SubjectStatus {
  return v === 'none' || v === 'yellow' || v === 'green' || v === 'gray' || v === 'blue';
}

// ============================
// グループ（旧: 病棟/場所）
// ============================

/** 大きな枠の区分（病棟・現場・チームなど。表示名はユーザーが自由に付ける）。 */
export interface Group {
  id: string;
  name: string;
  sortOrder: number;
}

// ============================
// タグ（単一種類・色なし）
// ============================

/**
 * 単純タグ。旧アプリの3系統（共有白タグ / 個人色タグ / 担当者割当）は持ち込まず、
 * 色・共有/個人区分のない 1 種類に統一した。定義は settings に置き、Subject は id を参照する
 * （改名時に全件書き換えないため）。
 */
export interface Tag {
  id: string;
  name: string;
  sortOrder: number;
}

// ============================
// 定型文（今回本文へのワンタップ挿入部品）
// ============================

/** 定型文（セクション本文へワンタップ挿入するテキスト部品。空欄は「__」等の慣習で）。 */
export interface Snippet {
  id: string;
  /** 一覧に出す短い名前（例: 採血・胸部Xp）。 */
  label: string;
  /** 挿入される本文（改行可）。 */
  body: string;
}

// ============================
// フォーム値（テンプレート group/item への入力値）
// ============================

/**
 * text 項目の保存値。正常文由来 (preset) か手入力由来 (manual) かを区別し、
 * ワンタップ正常チェックが手入力を誤って上書き/消去しないようにする
 * （旧回診 formatValues の provenance 設計を継承）。
 */
export interface TextEntry {
  value: string;
  source: 'preset' | 'manual';
}

/** number / fraction 項目の保存値。note は短い注記（例: SpO2 の酸素投与量）。 */
export interface NumericEntry {
  value: string;
  note?: string;
}

/**
 * フォーム値: formValues[groupId][itemId] = 保存値。
 * キーは配列 index ではなく安定 id（テンプレート編集で並びが変わっても値が迷子にならない）。
 * 保存形は TextEntry / NumericEntry / legacy 文字列を許し、読み出しは
 * domain/formValues.ts の正規化ヘルパを必ず通す。
 */
export type FormValues = Record<string, Record<string, unknown>>;

// ============================
// 対象（旧: 患者）
// ============================

/**
 * 対象（Subject）。1 レコード = 1 対象のフラット構造（Group は参照のみ）。
 * アーカイブは archivedAt のソフトデリート。
 *
 * 「今回分」(ラウンド開始・クリアで消えるもの) = status(青以外) / sectionText /
 * formValues / confirmedNote。
 * 「継続」(消えないもの) = name/code/location/groupId/problems/handover/tagIds。
 */
export interface Subject {
  id: string;
  /** 表示名（人名に限らない。設備名・案件名など）。 */
  name: string;
  /** 管理 ID・コード（旧: 患者ID。自由文字列・任意）。 */
  code: string;
  /** 位置（旧: 部屋。自由文字列・任意）。 */
  location: string;
  /** 所属グループ。null = 未分類。 */
  groupId: string | null;
  /** グループ内の並び順。 */
  sortOrder: number;
  status: SubjectStatus;
  /**
   * 問題リスト（順序つきの未解決項目）。1 要素 = 1 問題で、複数行可
   * （2 行目以降は経過などの補足。合成時は先頭行にだけ #n を付ける）。
   */
  problems: string[];
  /** 申し送り・継続メモ（自由記述。ラウンドをまたいで残る）。 */
  handover: string;
  /** セクションごとの今回本文: sectionText[sectionId] = 自由入力本文。 */
  sectionText: Record<string, string>;
  /** テンプレートのフォーム入力値（今回分）。 */
  formValues: FormValues;
  /** 清書（合成結果を人間が確認・修正した最終本文。QR に出すのはこれ）。 */
  confirmedNote: string;
  tagIds: string[];
  /** ソフトデリート時刻。null = 現役。 */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ============================
// ラウンド（旧: 回診）
// ============================

/** 進行中ラウンドの状態（settings に保持。長期履歴は持たない）。 */
export interface RoundState {
  startedAt: number;
  /** null = 進行中。終了してもデータは消えない（消すのは次の開始/手動クリア）。 */
  endedAt: number | null;
}

// ============================
// アプリ設定（settings store の単一レコード）
// ============================

/** QR 出力の改行モード。crlf = Windows 系編集欄向け（既定）/ lf = 元の改行を保持。 */
export type NewlineMode = 'crlf' | 'lf';

export interface AppSettings {
  key: 'app';
  /** 有効なテンプレート id（templates store のレコードを指す）。 */
  activeTemplateId: string;
  tags: Tag[];
  snippets: Snippet[];
  /** QR 出力の改行モード（既定 crlf）。 */
  newlineMode: NewlineMode;
  /** 進行中/直近のラウンド。null = 一度も開始していない。 */
  round: RoundState | null;
  /** 初回オンボーディング済みフラグ。 */
  onboardingDone: boolean;
  updatedAt: number;
}
