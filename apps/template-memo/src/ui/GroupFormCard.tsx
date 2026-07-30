/*
 * 常設群（display='always'）の入力カード。値は subject.formValues[group.id][item.id] へ
 * write-through 保存する（旧回診 ProjectionFormCard の操作感を継承）。
 *
 * このファイルは詳細画面のフォーム機構の共有 leaf でもある:
 *   - ItemInputRow: text/number/fraction の入力行（OncallSheet が一時値モードで再利用）。
 *   - commitSubjectPatch: subject への書き込みを直列化する唯一の経路。
 *     blur 保存とボタン操作（正常文ワンタップ・定型文挿入など）は同一イベント列で重なるため、
 *     並行に updateSubject を呼ぶと後勝ちで前の変更が消える（lost update）。キューで直列化し、
 *     patch は実行時点の最新 subject から組み立てる。
 *
 * 入力は「ローカル draft + blur で確定保存」方式（fail-closed: 保存失敗時は draft を
 * 保持して再試行できる。IDB 完了前に draft を捨てない）。
 */
import { useRef, useState, type CSSProperties } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useToast } from '@snishi/foundation/ui/toast';
import { getSubject, updateSubject } from '../data/store';
import {
  decidePresetToggle,
  manualTextEntry,
  normalizeTextEntry,
  numericEntry,
  readGroupValues,
  readNumericEntry,
  readTextValue,
} from '../domain/formValues';
import type { TemplateGroup, TemplateItem } from '../domain/template';
import type { NumericEntry, Subject, TextEntry } from '../domain/types';
import { errorText, t } from '../i18n';

// ============================
// subject への直列化書き込み（詳細画面の唯一の書き込み経路）
// ============================

export type SubjectPatch = Partial<Omit<Subject, 'id' | 'createdAt'>>;

/** 書き込みキュー。失敗しても後続が続けられるよう、チェーン自体は常に resolve へ倒す。 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * subject へ patch を直列に適用する。buildPatch は「実行時点の最新 subject」を受け取って
 * patch を返す（null = 何もしない）。返り値の Promise は成功/失敗をそのまま伝える
 * （失敗通知は呼び出し側の責務。draft の保持判断に使う）。
 */
export function commitSubjectPatch(
  id: string,
  buildPatch: (cur: Subject) => SubjectPatch | null,
): Promise<void> {
  const run = writeChain.then(async () => {
    const cur = getSubject(id);
    if (!cur) return; // 完全削除直後など。対象がなければ何もしない
    const patch = buildPatch(cur);
    if (patch === null) return;
    await updateSubject(id, patch);
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 保留中の書き込みすべての完了を待つ（QR 表示・コピーなど「確定値を読む」操作の直前用。
 * blur 保存が飛んだ直後の同一イベント列では store がまだ古いため）。
 */
export function pendingSubjectWrites(): Promise<void> {
  return writeChain;
}

// ============================
// 入力行（text / number / fraction）
// ============================

/** onCommit が Promise のときは成功時だけ onSuccess（失敗時は draft を保持・通知は親側）。 */
function finishCommit(result: void | Promise<void>, onSuccess: () => void): void {
  if (result instanceof Promise) {
    void result.then(onSuccess, () => undefined);
  } else {
    onSuccess();
  }
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 8,
};
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, flex: 'none' };
const valueInputStyle: CSSProperties = { flex: '1 1 140px', minWidth: 100, width: 'auto' };
const noteInputStyle: CSSProperties = { flex: '1 1 100px', minWidth: 80, width: 'auto' };
const unitStyle: CSSProperties = { color: 'var(--muted, #64748b)', flex: 'none' };

/**
 * 項目 1 つの入力行。値の読み書きは必ず domain/formValues.ts のヘルパ経由。
 * rawValue は保存形そのまま（TextEntry/NumericEntry/legacy 文字列/undefined）を受け取る。
 */
export function ItemInputRow({
  item,
  rawValue,
  onCommit,
  onPresetToggle,
}: {
  item: TemplateItem;
  rawValue: unknown;
  /** blur 時の確定保存。Promise を返す場合は成功時だけ draft を消す。 */
  onCommit: (stored: TextEntry | NumericEntry | '') => void | Promise<void>;
  /**
   * 正常文ワンタップ。write/clear/openEditor の判定は親が「最新値」で行う
   * （blur 保存と同一イベント列で重なるため、この行の rawValue は古い可能性がある）。
   * openEditor のときは渡した focusInput を呼んでもらう。
   */
  onPresetToggle?: (focusInput: () => void) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // draft = 編集中のローカル値（null = 非編集で保存値を表示）。number/fraction は注記も持つ。
  const [draft, setDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  if (item.kind === 'text') {
    const value = draft ?? readTextValue(rawValue);
    const isPreset =
      item.normal !== undefined && normalizeTextEntry(rawValue, item.normal).source === 'preset';
    const commitText = () => {
      if (draft === null) return;
      const committed = draft;
      if (committed === readTextValue(rawValue)) {
        setDraft(null);
        return;
      }
      finishCommit(onCommit(manualTextEntry(committed)), () =>
        setDraft((d) => (d === committed ? null : d)),
      );
    };
    return (
      <div style={rowStyle}>
        {item.label !== '' ? <span style={labelStyle}>{item.label}</span> : null}
        <input
          ref={inputRef}
          className="input"
          style={valueInputStyle}
          value={value}
          aria-label={item.label || item.normal || t('detail.noteInput')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
        />
        {item.normal !== undefined && onPresetToggle ? (
          <Button
            aria-pressed={isPreset}
            onClick={() => onPresetToggle(() => inputRef.current?.focus())}
          >
            {isPreset ? <Icon name="check" size={16} /> : null}
            {item.normal}
          </Button>
        ) : null}
      </div>
    );
  }

  // number / fraction: 値 + 単位 + 短い注記（例 SpO2 の酸素投与量）。
  const entry = readNumericEntry(rawValue);
  const value = draft ?? entry.value;
  const note = noteDraft ?? entry.note;
  const commitNumeric = () => {
    if (draft === null && noteDraft === null) return;
    if (value === entry.value && note === entry.note) {
      setDraft(null);
      setNoteDraft(null);
      return;
    }
    const committedValue = value;
    const committedNote = note;
    finishCommit(onCommit(numericEntry(committedValue, committedNote)), () => {
      // 保存中にもう一方の欄で入力が進んでいたら、その draft は消さない。
      setDraft((d) => (d === null || d === committedValue ? null : d));
      setNoteDraft((d) => (d === null || d === committedNote ? null : d));
    });
  };
  return (
    <div style={rowStyle}>
      {item.label !== '' ? <span style={labelStyle}>{item.label}</span> : null}
      <input
        ref={inputRef}
        className="input"
        style={valueInputStyle}
        value={value}
        inputMode={item.kind === 'number' ? 'decimal' : undefined}
        placeholder={item.kind === 'fraction' ? t('detail.fractionPlaceholder') : undefined}
        aria-label={item.label || t('detail.noteInput')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitNumeric}
      />
      {item.unit !== undefined ? <span style={unitStyle}>{item.unit}</span> : null}
      <input
        className="input"
        style={noteInputStyle}
        value={note}
        aria-label={t('detail.itemNote')}
        placeholder={t('detail.itemNote')}
        onChange={(e) => setNoteDraft(e.target.value)}
        onBlur={commitNumeric}
      />
    </div>
  );
}

// ============================
// 常設群カード
// ============================

/** formValues[groupId][itemId] だけを差し替える patch を作る（他 item は温存）。 */
function formValuesPatch(
  cur: Subject,
  groupId: string,
  itemId: string,
  stored: TextEntry | NumericEntry | '',
): SubjectPatch {
  return {
    formValues: {
      ...cur.formValues,
      [groupId]: { ...readGroupValues(cur.formValues, groupId), [itemId]: stored },
    },
  };
}

export function GroupFormCard({ subject, group }: { subject: Subject; group: TemplateGroup }) {
  const toast = useToast();
  const values = readGroupValues(subject.formValues, group.id);
  const notifyFail = (e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error');

  // 入力行の blur 確定保存（Promise を返す = 行側は成功時だけ draft を消す）。
  const commitItem = (itemId: string) => (stored: TextEntry | NumericEntry | '') => {
    const p = commitSubjectPatch(subject.id, (cur) =>
      formValuesPatch(cur, group.id, itemId, stored),
    );
    void p.catch(notifyFail);
    return p;
  };

  // 正常文ワンタップ。判定はキュー内で最新値に対して行う（直前の blur 保存を反映してから）。
  const presetToggle = (item: TemplateItem) => (focusInput: () => void) => {
    void commitSubjectPatch(subject.id, (cur) => {
      const raw = readGroupValues(cur.formValues, group.id)[item.id];
      const d = decidePresetToggle(raw, item.normal);
      if (d.action === 'openEditor') {
        // 手入力を守る: 上書きせず編集へ委ねる。
        focusInput();
        return null;
      }
      return formValuesPatch(cur, group.id, item.id, d.action === 'write' ? d.value : '');
    }).catch(notifyFail);
  };

  // 全部正常: 空の text item だけを正常文 (preset) で埋める。手入力・入力済みは触らない。
  const allNormal = () => {
    void commitSubjectPatch(subject.id, (cur) => {
      const rec = { ...readGroupValues(cur.formValues, group.id) };
      let changed = false;
      for (const item of group.items) {
        if (item.kind !== 'text' || item.normal === undefined) continue;
        if (readTextValue(rec[item.id]) !== '') continue;
        rec[item.id] = { value: item.normal, source: 'preset' } satisfies TextEntry;
        changed = true;
      }
      return changed ? { formValues: { ...cur.formValues, [group.id]: rec } } : null;
    }).catch(notifyFail);
  };

  const hasNormalText = group.items.some((i) => i.kind === 'text' && i.normal !== undefined);

  return (
    <section className="tm-card">
      <div className="tm-card-title">
        <span>{group.name}</span>
        {hasNormalText ? <Button onClick={allNormal}>{t('detail.allNormal')}</Button> : null}
      </div>
      {group.items.map((item) => (
        <ItemInputRow
          key={item.id}
          item={item}
          rawValue={values[item.id]}
          onCommit={commitItem(item.id)}
          onPresetToggle={
            item.kind === 'text' && item.normal !== undefined ? presetToggle(item) : undefined
          }
        />
      ))}
    </section>
  );
}
