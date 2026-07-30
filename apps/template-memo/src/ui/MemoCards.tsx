// 今回メモ / 継続メモ / 清書 (患者ごとの独立 textarea)。フォーマット/設定とは別構造。
//
// 仕様:
//   - 今回メモ (patient.visitMemo): 診察開始で常にクリア。AI handoff / 電子カルテQR の本文候補。
//   - 継続メモ (patient.standingMemo): 診察開始でクリアしない個人の継続メモ。既定で QR 非送信。
//   - 清書 (patient.confirmedNote): 記録補助 (note-assist) から清書返却QRで戻る本文。電子カルテQR の
//     本文に優先採用される (payload.ts)。診察開始でクリア。手で編集もできる。
//   - 入力は write-through (input ごとに revision 更新 + scheduleSave で保存予約)。
//   - 今回メモ / 清書は折りたたみ可能 (collapsible)。清書が入った患者では今回メモを畳んで清書を開く
//     (開閉初期値は DetailView が initialOpen で渡し、患者切替で remount してリセットする)。継続メモは常時表示。
//   - 患者は pid で捕捉する (前後ナビ・並び替えで別患者へ書かないため)。
//   - 旧 freeText は normalize が visitMemo へ移行済み (このカードでは触れない)。

import { useState } from 'react';
import type { Patient } from '../domain/types';
import type { AppRuntime } from './appRuntime';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/** 内容に応じて textarea を縦に伸ばす (field-sizing 未対応ブラウザ向けの JS フォールバック)。 */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

type MemoField = 'visitMemo' | 'standingMemo' | 'confirmedNote';

/** メモカード共通。field = patient のどのメモ欄へ書くか。collapsible なら折りたたみ (details) で描画。 */
function MemoCard({
  runtime,
  patient,
  field,
  label,
  placeholder,
  cardUi,
  inputUi,
  collapsible = false,
  initialOpen = true,
  forceOpenSignal = 0,
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
  collapsible?: boolean;
  initialOpen?: boolean;
  /** インクリメントされるたびに開く (清書作成→清書欄を開く等)。0 = 初期値 (無視)。 */
  forceOpenSignal?: number;
  rows?: number;
  /** 参照のみ (子端末の継続メモ/清書など。編集は正本PCで行う)。 */
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
  // 折りたたみの開閉。collapsible でない時は使わない (常時表示)。
  const [open, setOpen] = useState(initialOpen);
  // 外からの「開け」シグナル (remount せずに開く。入力中の他フィールドを壊さない)。
  // effect ではなく render 中の派生調整で反映する (react-hooks/set-state-in-effect 対応の推奨形)。
  const [seenOpenSignal, setSeenOpenSignal] = useState(forceOpenSignal);
  if (forceOpenSignal !== seenOpenSignal) {
    setSeenOpenSignal(forceOpenSignal);
    if (forceOpenSignal > 0 && !open) setOpen(true);
  }

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

  if (collapsible) {
    return (
      <details
        className="card panelCard memoCard memoCollapse"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        data-ui={cardUi}
      >
        <summary className="panelLabel memoCollapseSummary">{label}</summary>
        <div className="memoCollapseBody">{body}</div>
      </details>
    );
  }

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
 * 今回メモ (visitMemo)。診察開始でクリア。電子カルテQR / AI の本文候補。
 * 折りたたみ可。清書が入った患者では initialOpen=false で畳む (DetailView が制御)。
 */
export function VisitMemoCard({
  runtime,
  patient,
  initialOpen = true,
  forceOpenSignal = 0,
}: {
  runtime: AppRuntime;
  patient: Patient;
  initialOpen?: boolean;
  /** インクリメントされるたびに開く (定型文挿入→今回メモ欄を開く等)。 */
  forceOpenSignal?: number;
}) {
  return (
    <MemoCard
      runtime={runtime}
      patient={patient}
      field="visitMemo"
      label={s.memo.visit.label}
      placeholder={s.memo.visit.placeholder}
      cardUi={UI.memo.visit.card}
      inputUi={UI.memo.visit.input}
      collapsible
      initialOpen={initialOpen}
      forceOpenSignal={forceOpenSignal}
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

/**
 * 清書 (confirmedNote)。記録補助から清書返却QRで戻る本文。電子カルテQR の本文に優先採用される。
 * 折りたたみ可。清書が入っていれば initialOpen=true で開く (DetailView が制御)。手で編集もできる。
 */
export function CleanNoteCard({
  runtime,
  patient,
  initialOpen = false,
  forceOpenSignal,
}: {
  runtime: AppRuntime;
  patient: Patient;
  initialOpen?: boolean;
  /** 清書作成 (AiFormatCard) の成功時にインクリメントして開かせる。 */
  forceOpenSignal?: number;
}) {
  return (
    <MemoCard
      runtime={runtime}
      patient={patient}
      field="confirmedNote"
      label={s.memo.clean.label}
      placeholder={s.memo.clean.placeholder}
      cardUi={UI.memo.clean.card}
      inputUi={UI.memo.clean.input}
      collapsible
      initialOpen={initialOpen}
      forceOpenSignal={forceOpenSignal}
      rows={4}
    />
  );
}
