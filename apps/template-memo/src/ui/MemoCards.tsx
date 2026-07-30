// 今回メモ / 継続メモ (患者ごとの独立 textarea)。フォーマット/設定とは別構造。
//
// 仕様:
//   - 今回メモ (patient.visitMemo): ラウンド開始で常にクリア。転記用QR の本文候補。
//   - 継続メモ (patient.standingMemo): 診察開始でクリアしない個人の継続メモ。既定で QR 非送信。
//   - 入力は write-through (input ごとに revision 更新 + scheduleSave で保存予約)。
//   - 今回メモ / 継続メモはいずれも常時表示。
//   - 患者は pid で捕捉する (前後ナビ・並び替えで別患者へ書かないため)。
//   - 旧 freeText は normalize が visitMemo へ移行済み (このカードでは触れない)。

import type { Patient } from '../domain/types';
import type { AppRuntime } from './appRuntime';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/** 内容に応じて textarea を縦に伸ばす (field-sizing 未対応ブラウザ向けの JS フォールバック)。 */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

type MemoField = 'visitMemo' | 'standingMemo';

/** メモカード共通。field = patient のどのメモ欄へ書くか。 */
function MemoCard({
  runtime,
  patient,
  field,
  label,
  placeholder,
  cardUi,
  inputUi,
  rows = 2,
  readOnly = false,
  readOnlyHint,
}: {
  runtime: AppRuntime;
  patient: Patient;
  field: MemoField;
  label: string;
  placeholder: string;
  cardUi: string;
  inputUi: string;
  rows?: number;
  /** 参照のみ表示する場合。 */
  readOnly?: boolean;
  readOnlyHint?: string;
}) {
  const { store } = runtime;
  const pid = patient.pid;

  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  const raw = patient[field];
  const value = typeof raw === 'string' ? raw : '';
  function write(next: string): void {
    if (readOnly) return;
    const p = live();
    if (!p) return;
    p[field] = next;
    // 端末間同期は剥離済みのため群 revision は持たない (updatedAt のみ)。
    store.markUpdated(liveNo(), { bumpLight: field === 'visitMemo' });
    store.scheduleSave();
  }

  const textarea = (
    <textarea
      className="textarea memoInput"
      rows={rows}
      value={value}
      placeholder={readOnly ? '' : placeholder}
      aria-label={label}
      data-ui={inputUi}
      readOnly={readOnly}
      onFocus={(e) => autosize(e.currentTarget)}
      onChange={(e) => {
        write(e.target.value);
        autosize(e.currentTarget);
      }}
    />
  );
  const body = (
    <>
      {readOnly && readOnlyHint ? <p className="muted memoReadOnlyHint">{readOnlyHint}</p> : null}
      {textarea}
    </>
  );

  return (
    <section className="card panelCard memoCard" aria-label={label} data-ui={cardUi}>
      <div className="panelCardHead">
        <div className="panelLabel">{label}</div>
      </div>
      {body}
    </section>
  );
}

/**
 * 今回メモ (visitMemo)。ラウンド開始でクリア。転記用QR の本文候補。常時表示。
 */
export function VisitMemoCard({ runtime, patient }: { runtime: AppRuntime; patient: Patient }) {
  return (
    <MemoCard
      runtime={runtime}
      patient={patient}
      field="visitMemo"
      label={s.memo.visit.label}
      placeholder={s.memo.visit.placeholder}
      cardUi={UI.memo.visit.card}
      inputUi={UI.memo.visit.input}
    />
  );
}

/**
 * 継続メモ (standingMemo)。診察開始で残す個人の継続メモ。常時表示。
 */
export function StandingMemoCard({ runtime, patient }: { runtime: AppRuntime; patient: Patient }) {
  return (
    <MemoCard
      runtime={runtime}
      patient={patient}
      field="standingMemo"
      label={s.memo.standing.label}
      placeholder={s.memo.standing.placeholder}
      cardUi={UI.memo.standing.card}
      inputUi={UI.memo.standing.input}
    />
  );
}
