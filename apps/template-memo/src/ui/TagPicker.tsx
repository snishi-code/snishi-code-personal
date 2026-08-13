// タグ選択・絞り込み UI ウィジェット。
// (コピー元: hospital-workspace/rounds/ui/TagPicker.tsx。共有タグ・「自分の担当」は剥離 = 単一タグ化)
//
// - TagSelection: タグ複数選択チップ列 (+ 新規タグ追加)。患者編集に
//   inline で埋め込む (複数選択 = 開いたまま)。
// - TagFilterPicker: ホームのタグ絞り込み (AND 固定 + クリア)。
//   タグフィルタ状態 (ui/tags.ts) を更新し onChange で再描画させる。

import { useState } from 'react';
import { Popup } from '@snishi/foundation/ui/Popup';
import { Icon } from '@snishi/foundation/ui/Icon';
import { useToast } from '@snishi/foundation/ui/toast';
import type { HrStore } from '../data/store';
import type { TagColor } from '../domain/types';
import { DEFAULT_TAG_COLOR } from '../domain/tags';
import { addNewTag, getAllTags, getHomeTagFilter, setHomeTagFilter, tagColorOf } from './tags';
import { useRegisterOverlay } from './registries';
import { s } from '../i18n';
import { UI } from '../ui-contract';

/**
 * 「+ 新規タグ」ウィジェット (タップで入力欄に展開 → Enter/blur で確定)。
 * newTagColor で追加タグの色 = ラウンド開始で外れるかを決める。既定は残る側
 * (domain/tags.ts の DEFAULT_TAG_COLOR)。あとから設定のタグ管理で変更できる。
 */
export function AddTagWidget({
  store,
  onAdded,
  newTagColor = DEFAULT_TAG_COLOR,
}: {
  store: HrStore;
  onAdded: () => void;
  newTagColor?: TagColor;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function commit(): void {
    const name = draft.trim();
    setEditing(false);
    setDraft('');
    if (!name) return;
    if (!addNewTag(store, name, newTagColor)) {
      toast.show(s.settings.tag.name.duplicate, 'error');
      return;
    }
    onAdded();
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="tagAddBtn"
        title={s.tag.add.title}
        aria-label={s.tag.add.aria}
        data-ui={UI.tags.addBtn}
        onClick={() => setEditing(true)}
      >
        <Icon name="add" size={14} />
      </button>
    );
  }
  return (
    <input
      className="input tagAddInput"
      type="text"
      value={draft}
      placeholder={s.tag.placeholder}
      autoComplete="off"
      aria-label={s.tag.add.aria}
      // 明示タップで現れた単一入力なので autoFocus してよい (中央ルールの明示経路)
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(false);
          setDraft('');
        }
      }}
    />
  );
}

/**
 * タグ複数選択 (inline チップ列 + 新規タグ追加)。selected はタグ名の配列。
 * onChange は新しい選択配列を返す (保存は呼び出し側の責務)。
 */
export function TagSelection({
  store,
  selected,
  onChange,
  allowAdd = true,
  newTagColor = DEFAULT_TAG_COLOR,
}: {
  store: HrStore;
  selected: string[];
  onChange: (next: string[]) => void;
  allowAdd?: boolean;
  /** 新規追加タグの色 (= ラウンド開始で外れるか)。 */
  newTagColor?: TagColor;
}) {
  const [, setTick] = useState(0); // タグ追加後の一覧更新
  const settings = store.getSettings();
  const all = getAllTags(settings);
  const set = new Set(selected);
  return (
    <div className="tagSelection">
      {all.map((name) => {
        const on = set.has(name);
        const color = tagColorOf(settings, name);
        // 色は全色に modifier を付ける (素の .tagChip は未選択の外枠だけを担う)。
        const colorMod = ` tagChip--${color}`;
        return (
          <button
            key={name}
            type="button"
            className={`tagChip${colorMod}${on ? ' on' : ''}`}
            aria-pressed={on}
            data-ui={UI.tags.selectChip}
            onClick={() => {
              const next = on ? selected.filter((x) => x !== name) : [...selected, name];
              onChange(next);
            }}
          >
            {name}
          </button>
        );
      })}
      {allowAdd ? (
        <AddTagWidget
          store={store}
          onAdded={() => setTick((n) => n + 1)}
          newTagColor={newTagColor}
        />
      ) : null}
    </div>
  );
}

/**
 * タグ絞り込みピッカー (ホーム用)。タグフィルタ状態を直接更新する。
 * 複数選択 = 開いたまま (背景タップ/× で閉じる)。onChange で親 view が再描画する。
 */
export function TagFilterPicker({ store, onChange }: { store: HrStore; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const selected = getHomeTagFilter();
  const activeCount = selected.length;
  // 絞り込み候補 = 個人タグ (settings.tags)。重複排除。
  const tags = getAllTags(store.getSettings()).filter(
    (n, i, arr) => n.trim() && arr.indexOf(n) === i,
  );

  function update(next: string[]): void {
    setHomeTagFilter(next);
    setTick((n) => n + 1);
    onChange();
  }

  return (
    <>
      <button
        type="button"
        className={`tagFilterBtn${activeCount ? ' active' : ''}`}
        title={s.tag.sheet.filterTitle}
        aria-label={s.tag.sheet.filterTitle}
        data-ui={UI.tags.filterOpen}
        onClick={() => setOpen(true)}
      >
        <Icon name="tag" size={16} />
        {activeCount ? <span className="tagFilterCount">{activeCount}</span> : null}
      </button>
      {open ? (
        <TagFilterSheet
          store={store}
          tags={tags}
          selected={selected}
          onUpdate={update}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function TagFilterSheet({
  store,
  tags,
  selected,
  onUpdate,
  onClose,
}: {
  store: HrStore;
  tags: string[];
  selected: string[];
  onUpdate: (next: string[]) => void;
  onClose: () => void;
}) {
  useRegisterOverlay(onClose);
  const settings = store.getSettings();
  return (
    <Popup ariaLabel={s.tag.sheet.filterTitle} onClose={onClose} dataUi={UI.tags.filterSheet}>
      <div className="tagFilterSheet">
        <div className="tagSelection">
          {tags.length === 0 ? <p className="muted">{s.tag.filter.empty}</p> : null}
          {tags.map((name) => {
            const on = selected.includes(name);
            const color = tagColorOf(settings, name);
            const colorMod = ` tagChip--${color}`;
            return (
              <button
                key={name}
                type="button"
                className={`tagChip${colorMod}${on ? ' on' : ''}`}
                aria-pressed={on}
                data-ui={UI.tags.filterOption}
                onClick={() =>
                  onUpdate(on ? selected.filter((x) => x !== name) : [...selected, name])
                }
              >
                {name}
              </button>
            );
          })}
        </div>
        {selected.length ? (
          <button
            type="button"
            className="btn tagFilterClearBtn"
            title={s.tag.filter.clear.label}
            aria-label={s.tag.filter.clear.aria}
            onClick={() => onUpdate([])}
          >
            {s.tag.filter.clear.label}
          </button>
        ) : null}
      </div>
    </Popup>
  );
}
