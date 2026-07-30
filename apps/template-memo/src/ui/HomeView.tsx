/*
 * ホーム一覧。グループ/タグで絞り込み、対象行のステータスをワンタップ循環し、
 * 下部バーからラウンド開始/終了・対象追加を行う。破壊的操作（開始/クリア）は
 * ConfirmDialog で明示確認し、失敗は toast で通知する（fail-closed: store 側が
 * IDB 書き込み成功までメモリを進めないため、失敗時は画面も変わらない）。
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Button } from '@snishi/foundation/ui/Button';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { EmptyState } from '@snishi/foundation/ui/EmptyState';
import { TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { Menu, type MenuItem } from '@snishi/foundation/ui/Menu';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import {
  addSubject,
  reorderSubject,
  setSubjectStatus,
  sortedGroups,
  startRound,
  clearRound,
  endRound,
  subjectsInGroup,
  undoLastClear,
} from '../data/store';
import type { Subject } from '../domain/types';
import { errorText, t } from '../i18n';
import { cycleStatus, StatusDot, statusLabel } from './status';
import { useStore } from './useStore';

// グループフィルタの番兵値。実グループ id は newId('grp') 由来（'grp_…'）なので衝突しない。
const FILTER_ALL = 'all';
const FILTER_NONE = 'none';

// 行の中央（名前+meta）を開くボタン。既定の button 装飾を落とす。
const rowOpenStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 44,
  padding: 0,
  border: 'none',
  background: 'transparent',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

// チップの選択表示（status.tsx の StatusPicker と同じ見た目に揃える）。
const chipSelectedStyle: CSSProperties = {
  background: 'var(--primary-fill)',
  borderColor: 'var(--primary-fill)',
  color: 'var(--on-primary)',
};

/** 絞り込みチップ（44px タップ領域 = .tm-chip・選択中は塗り+aria-pressed）。 */
function FilterChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tm-chip"
      aria-pressed={selected}
      style={selected ? chipSelectedStyle : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface Section {
  key: string;
  /** グループ見出し（「すべて」表示のときだけ出す。null = 見出しなし）。 */
  heading: string | null;
  subjects: Subject[];
}

export function HomeView({
  onOpenSubject,
  onOpenSettings,
  onOpenArchive,
}: {
  onOpenSubject: (id: string) => void;
  onOpenSettings: () => void;
  onOpenArchive: () => void;
}) {
  const state = useStore();
  const toast = useToast();
  const [groupFilter, setGroupFilter] = useState<string>(FILTER_ALL);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<'start' | 'clear' | null>(null);
  const [addForm, setAddForm] = useState<{ name: string; code: string; location: string } | null>(
    null,
  );

  // 書き込み系の共通エラーハンドラ（fail-closed: 失敗は必ず可視化する）。
  const run = (op: Promise<unknown>) => {
    void op.catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  const groups = sortedGroups(state);
  const unassigned = subjectsInGroup(null, state);
  const round = state.settings.round;
  const roundRunning = round !== null && round.endedAt === null;

  const applyTagFilter = (xs: Subject[]) =>
    tagFilter === null ? xs : xs.filter((x) => x.tagIds.includes(tagFilter));

  // 表示セクション: 「すべて」はグループ順+末尾に未分類（空グループは出さない）。
  let sections: Section[];
  if (groupFilter === FILTER_ALL) {
    sections = [
      ...groups.map((g) => ({
        key: g.id,
        heading: g.name,
        subjects: applyTagFilter(subjectsInGroup(g.id, state)),
      })),
      {
        key: FILTER_NONE,
        // グループが 1 つもないうちは「未分類」見出し自体が意味を持たない。
        heading: groups.length > 0 ? t('home.noGroup') : null,
        subjects: applyTagFilter(unassigned),
      },
    ].filter((sec) => sec.subjects.length > 0);
  } else if (groupFilter === FILTER_NONE) {
    sections = [{ key: FILTER_NONE, heading: null, subjects: applyTagFilter(unassigned) }];
  } else {
    sections = [
      {
        key: groupFilter,
        heading: null,
        subjects: applyTagFilter(subjectsInGroup(groupFilter, state)),
      },
    ];
  }
  const visibleCount = sections.reduce((n, sec) => n + sec.subjects.length, 0);

  // ↑↓は「単一グループ表示 + タグ絞り込みなし」のときだけ出す
  // （絞り込み中は隣が隠れていて入れ替えが見た目に反映されないため）。
  const showReorder = groupFilter !== FILTER_ALL && tagFilter === null;

  const submitAdd = () => {
    if (!addForm) return;
    // 特定グループ表示中はそのグループへ、「すべて/未分類」は未分類へ追加。
    const groupId = groupFilter !== FILTER_ALL && groupFilter !== FILTER_NONE ? groupFilter : null;
    void addSubject(addForm, groupId)
      .then(() => setAddForm(null))
      .catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  const doConfirm = () => {
    if (!confirm) return;
    void (confirm === 'start' ? startRound() : clearRound())
      .then(() => setConfirm(null))
      .catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  const doUndo = () => {
    void undoLastClear()
      .then((ok) =>
        toast.show(t(ok ? 'home.roundUndoDone' : 'home.roundUndoNone'), ok ? 'success' : 'info'),
      )
      .catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  const menuItems: MenuItem[] = [
    {
      key: 'clear',
      label: t('home.roundClear'),
      icon: 'delete',
      onSelect: () => setConfirm('clear'),
    },
    { key: 'undo', label: t('home.roundUndo'), icon: 'reverse', onSelect: doUndo },
    { key: 'archive', label: t('home.archive'), icon: 'archive', onSelect: onOpenArchive },
    { key: 'settings', label: t('home.settings'), icon: 'settings', onSelect: onOpenSettings },
  ];

  return (
    <div className="tm-screen">
      <AppHeader
        center={<h1 style={{ fontSize: '1rem', margin: 0 }}>{t('app.title')}</h1>}
        right={
          <>
            <IconButton label={t('home.settings')} onClick={onOpenSettings}>
              <Icon name="settings" />
            </IconButton>
            <IconButton
              label={t('home.menu')}
              aria-haspopup="dialog"
              onClick={() => setMenuOpen(true)}
            >
              <Icon name="menu" />
            </IconButton>
          </>
        }
      />

      <main className="tm-main">
        {roundRunning ? (
          <div className="tm-card">
            {t('home.roundRunning')}・{new Date(round.startedAt).toLocaleTimeString()}
          </div>
        ) : null}

        {/* グループフィルタ: すべて / 各グループ / 未分類（未分類対象がいる時だけ） */}
        <div className="tm-chip-row" role="group" aria-label={t('detail.group')}>
          <FilterChip
            selected={groupFilter === FILTER_ALL}
            onClick={() => setGroupFilter(FILTER_ALL)}
          >
            {t('home.allGroups')}
          </FilterChip>
          {groups.map((g) => (
            <FilterChip
              key={g.id}
              selected={groupFilter === g.id}
              onClick={() => setGroupFilter(g.id)}
            >
              {g.name}
            </FilterChip>
          ))}
          {unassigned.length > 0 ? (
            <FilterChip
              selected={groupFilter === FILTER_NONE}
              onClick={() => setGroupFilter(FILTER_NONE)}
            >
              {t('home.noGroup')}
            </FilterChip>
          ) : null}
        </div>

        {/* タグフィルタ（単一選択・再タップで解除） */}
        {state.settings.tags.length > 0 ? (
          <div className="tm-chip-row" role="group" aria-label={t('home.filterByTag')}>
            {[...state.settings.tags]
              .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
              .map((tag) => (
                <FilterChip
                  key={tag.id}
                  selected={tagFilter === tag.id}
                  onClick={() => setTagFilter((cur) => (cur === tag.id ? null : tag.id))}
                >
                  {tag.name}
                </FilterChip>
              ))}
          </div>
        ) : null}

        {visibleCount === 0 ? (
          <EmptyState message={t('home.empty')} />
        ) : (
          sections.map((sec) => (
            <section key={sec.key}>
              {sec.heading !== null ? (
                <h2 style={{ fontSize: '0.9em', color: 'var(--muted)', margin: '16px 0 8px' }}>
                  {sec.heading}
                </h2>
              ) : null}
              {sec.subjects.map((x) => (
                <div key={x.id} className="tm-subject-row" data-status={x.status}>
                  {/* 左の色丸 = ステータスのワンタップ循環（行タップとは独立したボタン） */}
                  <IconButton
                    label={statusLabel(x.status)}
                    onClick={() => run(setSubjectStatus(x.id, cycleStatus(x.status)))}
                  >
                    <StatusDot status={x.status} />
                  </IconButton>
                  <button type="button" style={rowOpenStyle} onClick={() => onOpenSubject(x.id)}>
                    <div style={{ fontWeight: 600 }}>{x.name || t('home.untitledSubject')}</div>
                    {x.code !== '' || x.location !== '' ? (
                      <div className="tm-subject-meta">
                        {[x.code, x.location].filter((v) => v !== '').join(' / ')}
                      </div>
                    ) : null}
                  </button>
                  {showReorder ? (
                    <>
                      <IconButton
                        label={t('tpl.moveUp')}
                        onClick={() => run(reorderSubject(x.id, -1))}
                      >
                        <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
                          <Icon name="expand" />
                        </span>
                      </IconButton>
                      <IconButton
                        label={t('tpl.moveDown')}
                        onClick={() => run(reorderSubject(x.id, 1))}
                      >
                        <Icon name="expand" />
                      </IconButton>
                    </>
                  ) : null}
                </div>
              ))}
            </section>
          ))
        )}
      </main>

      <div className="tm-bottom-bar">
        <Button variant="primary" onClick={() => setAddForm({ name: '', code: '', location: '' })}>
          {t('home.addSubject')}
        </Button>
        <Button onClick={() => setConfirm('start')}>{t('home.roundStart')}</Button>
        {roundRunning ? (
          <Button onClick={() => run(endRound())}>{t('home.roundEnd')}</Button>
        ) : null}
      </div>

      {menuOpen ? (
        <Menu title={t('home.menu')} items={menuItems} onClose={() => setMenuOpen(false)} />
      ) : null}

      {confirm !== null ? (
        <ConfirmDialog
          title={t(
            confirm === 'start' ? 'home.roundStartConfirmTitle' : 'home.roundClearConfirmTitle',
          )}
          body={t(
            confirm === 'start' ? 'home.roundStartConfirmBody' : 'home.roundClearConfirmBody',
          )}
          confirmLabel={t(confirm === 'start' ? 'home.roundStart' : 'home.roundClear')}
          cancelLabel={t('common.cancel')}
          danger={confirm === 'clear'}
          onConfirm={doConfirm}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {addForm !== null ? (
        // 入力途中の背景タップで消えないよう never（閉じるのは × / キャンセル / 追加成功時）。
        <Modal
          title={t('home.addSubject')}
          variant="dialog"
          dismissMode="never"
          onClose={() => setAddForm(null)}
          closeLabel={t('common.close')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAddForm(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={submitAdd}>
                {t('common.add')}
              </Button>
            </>
          }
        >
          <TextInput
            label={t('detail.name')}
            value={addForm.name}
            onChange={(v) => setAddForm({ ...addForm, name: v })}
          />
          <TextInput
            label={t('detail.code')}
            value={addForm.code}
            onChange={(v) => setAddForm({ ...addForm, code: v })}
          />
          <TextInput
            label={t('detail.location')}
            value={addForm.location}
            onChange={(v) => setAddForm({ ...addForm, location: v })}
          />
        </Modal>
      ) : null}
    </div>
  );
}
