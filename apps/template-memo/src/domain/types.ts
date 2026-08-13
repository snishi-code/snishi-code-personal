/*
 * template-memo のドメイン型。
 *
 * 系譜: medical 側 hospital-workspace/rounds の Patient/Place モデルを UI ごと移植し、
 * 単一ユーザー向けに剥離した（ユーザー/役割/担当者・AI・同期・roster・次回診察日は持たない）。
 * コードの識別子はコピー元のまま（pid / patient / room 等）。UI 文言だけを i18n で中立語化する。
 */

// ============================
// ステータス（5色・固定意味）
// ============================

/**
 * ステータスの固定意味（UI 色・ラウンドクリアの対象判定はこの意味に従う）:
 *   NONE   白 = 未（未着手）
 *   YELLOW 黄 = 途中（対応中・記載前）
 *   GREEN  緑 = 済（今回の確認・作業が済んだ）
 *   GRAY   灰 = 転記済（完成文を出力先へ書き写すところまで済んだ）
 *   BLUE   青 = 特記（新規・要注意など。ラウンド開始でも消えない）
 */
export const STATUS = Object.freeze({
  NONE: 'none',
  YELLOW: 'yellow',
  GREEN: 'green',
  GRAY: 'gray',
  BLUE: 'blue',
} as const);
export type PatientStatus = (typeof STATUS)[keyof typeof STATUS];

export function isPatientStatus(v: unknown): v is PatientStatus {
  return v === 'none' || v === 'yellow' || v === 'green' || v === 'gray' || v === 'blue';
}

export function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ============================
// place（旧 v1 の Group 相当。UI 上の呼称はグループ）
// ============================

/*
 * テンプレートの適用範囲の用語（実ユーズレビュー 2026-08-14）:
 *   アプリ   = AppSettings.defaultTemplateId（アプリ全体のデフォルト）
 *   グループ = PlaceDef.templateId（グループ作成時にアプリのデフォルトを写す）
 *   ページ   = Patient.templateId（対象の詳細入力画面。作成時にグループのデフォルトを写す）
 * デフォルトは「作成時に写す」方式で、後からアプリ/グループの設定を変えても
 * 既存のグループ/ページには波及しない（それぞれの設定で個別に変える）。
 */

export interface PlaceDef {
  placeId: string;
  name: string;
  /** このグループで新しく作るページに写すテンプレート id。 */
  templateId: string;
}

// ============================
// タグ（名前参照・色は「ラウンド開始で外れるか」の意味を持つ）
// ============================

/**
 * 個人タグの色。見た目ではなく「ラウンド開始で外れるか」を表す:
 *   blue  = 残る（継続の目印）
 *   amber = ラウンド開始で対象から外れる（今回分の目印）
 * 判定は色リテラルを散らさず domain/tags.ts の tagClearsOnRoundStart に集約する
 * （blue 以外は外れる側 = あとから足した色は自動で外れる側に入る）。
 */
export const TAG_COLORS = Object.freeze(['blue', 'amber'] as const);
export type TagColor = (typeof TAG_COLORS)[number];

/** タグの定義オブジェクト（settings.tags が正本）。patient.tags は名前参照の string[]。 */
export interface TagDef {
  name: string;
  color: TagColor;
}

// ============================
// フォーム値（テンプレートの配置/item への入力値）
// ============================

/**
 * 項目の保存値。正常文由来 (preset) か手入力由来 (manual) かを区別し、
 * ワンタップ正常チェックが手入力を誤って上書き/消去しないようにする
 * （回診 formatValues の provenance 設計を継承）。
 *
 * note は旧 number / fraction 項目に付いていた短い注記（例: SpO2 の酸素投与量）。
 * 入力 UI は当初から存在せず、新規に作られることはない。既存データ・取り込み JSON の
 * 出力を落とさないためだけに読み書きを通す（合成では値+単位の後ろに付く）。
 */
export interface TextEntry {
  value: string;
  source: 'preset' | 'manual';
  note?: string;
}

/**
 * フォーム値: formValues[placementId][itemId] = 保存値。
 * キーは配列 index ではなく安定 id（テンプレート編集で並びが変わっても値が迷子にならない）。
 * 保存形は TextEntry（未入力は ''）。読み出しは domain/formValues.ts の
 * 正規化ヘルパを必ず通す（object 以外は未入力へ倒す fail-safe）。
 *
 * 旧 number / fraction の保存形 { value, note? }（source なし）も、そのまま
 * 手入力値として読み取る（種類を畳んだときに値が消えないため。formValues.ts 参照）。
 */
export type FormValues = Record<string, Record<string, unknown>>;

// ============================
// 患者（コピー元の識別子のまま。UI 呼称は「対象」）
// ============================

/**
 * 1 レコード = 1 件のフラット構造（place は参照属性）。アーカイブは archivedAt のソフトデリート。
 *
 * 「今回分」(ラウンド開始・クリアで消えるもの) = status(青以外) / sectionTexts /
 * projectedValues / tags(青以外の色)。
 * 「継続」(消えないもの) = name / room / placeId / problems / standingMemo / tags(青)。
 */
export interface Patient {
  pid: string;
  status: PatientStatus;
  /** 表示名（人名に限らない。設備名・案件名など）。 */
  name: string;
  /** 位置（旧: 部屋番号。自由文字列・任意）。 */
  room: string;
  /** 所属 place。'' = 未所属（通常は作成時に必ず割り当てる）。 */
  placeId: string;
  /** 個人タグ（名前参照。定義と色 = settings.tags）。 */
  tags: string[];
  /** プロブレムリスト。番号は保存せず、表示・合成時に配列順から自動付番する。 */
  problems: string[];
  /**
   * 場所ごとの自由本文（今回分）。key = フレームの場所 id・値 = その場所に書いた本文。
   * ラウンド開始で常にクリアする。合成では freeText の場所だけがこの本文を拾う。
   */
  sectionTexts: Record<string, string>;
  /** 継続メモ。ラウンド開始でクリアしない。 */
  standingMemo: string;
  /**
   * このページで使うテンプレート id。作成時に所属グループの templateId を写す。
   * ラウンド開始でもクリアしない（継続）。参照先が消えた場合の解決は
   * store.getTemplateForPatient が グループ → アプリ の順に倒す。
   */
  templateId: string;
  /**
   * テンプレートのフォーム入力値（今回分）。名前はコピー元 UI に合わせて projectedValues の
   * まま、型は合成エンジンの FormValues（formValues[placementId][itemId]・provenance 付き）。
   * 読み書きは domain/formValues.ts のヘルパ経由。
   */
  projectedValues: FormValues;
  updatedAt: number;
  /** ソフトデリート時刻。null = 現役。 */
  archivedAt: number | null;
}

// ============================
// アプリ設定（settings store の単一レコード）
// ============================

/** QR 出力の改行モード。crlf = Windows 系編集欄向け（既定）/ lf = 元の改行を保持。 */
export type NewlineMode = 'crlf' | 'lf';

export interface AppSettings {
  key: 'app';
  /** アプリ全体のデフォルトテンプレート id（新しいグループ作成時に写す）。 */
  defaultTemplateId: string;
  /** 個人タグの定義（色 = ラウンド開始で外れるか。domain/tags.ts 参照）。 */
  tags: TagDef[];
  /** QR 出力の改行モード（既定 crlf）。 */
  newlineMode: NewlineMode;
  updatedAt: number;
}

// ============================
// live 状態（コピー元 UI の AppState 契約）
// ============================

/** アクティブビュー（place またはアーカイブ）の live 状態。 */
export interface AppState {
  title: string;
  patients: Patient[];
}
