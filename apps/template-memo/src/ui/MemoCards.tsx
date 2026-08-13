// 継続メモ (患者ごとの独立 textarea)。フォーマット/設定とは別構造。
//
// 仕様:
//   - 継続メモ (patient.standingMemo): 診察開始でクリアしない個人の継続メモ。既定で QR 非送信。
//   - 入力は write-through (input ごとに保存予約)。updatedAt は上げない (bumpLight: false)。
//   - 常時表示。
//   - 患者は pid で捕捉する (並び替えで別患者へ書かないため)。
//   - 今回分の自由本文はここではなく入力フォーム (ProjectionFormCard) の各場所が持つ。

import type { Patient } from '../domain/types';
import type { AppRuntime } from './appRuntime';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/**
 * 内容に応じて textarea を縦に伸ばす (field-sizing 未対応ブラウザ向けの JS フォールバック)。
 * 場所ごとの自由入力欄 (ProjectionFormCard) も同じ挙動にするためここから共有する。
 */
export function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * 継続メモ (standingMemo)。診察開始で残す個人の継続メモ。常時表示。
 */
export function StandingMemoCard({ runtime, patient }: { runtime: AppRuntime; patient: Patient }) {
  const { store } = runtime;
  const pid = patient.pid;

  const live = () => store.getAppState().patients.find((x) => x.pid === pid) ?? null;
  // markUpdated は 1-based の患者番号を取る (store: patients[no - 1])。
  const liveNo = () => store.getAppState().patients.findIndex((x) => x.pid === pid) + 1;

  const raw = patient.standingMemo;
  const value = typeof raw === 'string' ? raw : '';
  function write(next: string): void {
    const p = live();
    if (!p) return;
    p.standingMemo = next;
    // 端末間同期は剥離済みのため群 revision は持たない (updatedAt のみ)。
    // 継続メモは「今回分」ではないので updatedAt を上げない。
    store.markUpdated(liveNo(), { bumpLight: false });
    store.scheduleSave();
  }

  const label = s.memo.standing.label;
  return (
    <section className="card panelCard memoCard" aria-label={label} data-ui={UI.memo.standing.card}>
      <div className="panelCardHead">
        <div className="panelLabel">{label}</div>
      </div>
      <textarea
        className="textarea memoInput"
        rows={2}
        value={value}
        placeholder={s.memo.standing.placeholder}
        aria-label={label}
        data-ui={UI.memo.standing.input}
        onFocus={(e) => autosize(e.currentTarget)}
        onChange={(e) => {
          write(e.target.value);
          autosize(e.currentTarget);
        }}
      />
    </section>
  );
}
