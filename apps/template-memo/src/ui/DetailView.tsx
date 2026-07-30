/*
 * 対象詳細（このアプリの心臓部）。上から:
 *   ヘッダー（戻る・対象名・編集）→ ステータス → 問題リスト → 申し送り →
 *   有効テンプレートのセクション（常設群カード / 呼び出しチップ / 定型文 / 自由本文）→
 *   清書（定型清書・コピー・QR表示）→ 下部バー（アーカイブへ移動）。
 *
 * 書き込みはすべて commitSubjectPatch（直列キュー）経由。テキスト欄は
 * 「ローカル draft + blur で確定保存」で、保存失敗時は draft を保持して toast 通知する
 * （fail-closed: 見た目だけ先へ進めない・入力を黙って失わない）。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Button } from '@snishi/foundation/ui/Button';
import { ConfirmDialog } from '@snishi/foundation/ui/ConfirmDialog';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { useToast } from '@snishi/foundation/ui/toast';
import { activeTemplate, archiveSubject, getSubject } from '../data/store';
import { composePresetClean, type TemplateGroup } from '../domain/template';
import type { Subject } from '../domain/types';
import { errorText, t } from '../i18n';
import { commitSubjectPatch, GroupFormCard, pendingSubjectWrites } from './GroupFormCard';
import type { SubjectPatch } from './GroupFormCard';
import { OncallSheet } from './OncallSheet';
import { QrDialog } from './QrDialog';
import { SnippetPicker } from './SnippetPicker';
import { StatusPicker } from './status';
import { SubjectEditPopup } from './SubjectEditPopup';
import { useStore } from './useStore';

// ヘッダー中央の対象名ボタン（既定の button 装飾を落とし、長い名前は省略記号で切る）。
const nameButtonStyle: CSSProperties = {
  minHeight: 44,
  maxWidth: '100%',
  padding: 0,
  border: 'none',
  background: 'transparent',
  font: 'inherit',
  fontWeight: 600,
  color: 'inherit',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const hintStyle: CSSProperties = {
  margin: '0 0 4px',
  fontSize: 12,
  color: 'var(--muted, #64748b)',
};
const mutedStyle: CSSProperties = { margin: '8px 0 0', color: 'var(--muted, #64748b)' };

/**
 * 確定保存つき textarea。編集中はローカル draft を表示し、blur で onCommit へ渡す。
 * 保存成功時だけ draft を消す（失敗時は draft 維持 = 入力を失わない。通知は親側）。
 */
function DraftTextarea({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  style,
}: {
  value: string;
  onCommit: (next: string) => Promise<void>;
  ariaLabel: string;
  placeholder?: string;
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      className="tm-textarea"
      style={style}
      value={draft ?? value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        if (draft === value) {
          setDraft(null);
          return;
        }
        const committed = draft;
        void onCommit(committed).then(
          // 保存中に再編集された draft は消さない。
          () => setDraft((d) => (d === committed ? null : d)),
          () => undefined,
        );
      }}
    />
  );
}

export function DetailView({ subjectId, onBack }: { subjectId: string; onBack: () => void }) {
  const state = useStore();
  const toast = useToast();
  const subject = getSubject(subjectId, state);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  // 開いている呼び出し群（挿入先セクションもここで覚える）。
  const [oncall, setOncall] = useState<{ sectionId: string; group: TemplateGroup } | null>(null);

  // 完全削除・復元データ置換などで対象が消えたらホームへ戻す。
  const missing = subject === null;
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);
  if (!subject) return null;

  const template = activeTemplate(state);
  const snippets = state.settings.snippets;

  const notifyFail = (e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error');

  // 書き込みの共通経路（直列キュー + 失敗通知）。返り値は draft 保持判断用にそのまま返す。
  const commit = (build: (cur: Subject) => SubjectPatch | null): Promise<void> => {
    const p = commitSubjectPatch(subjectId, build);
    void p.catch(notifyFail);
    return p;
  };

  // セクション本文の末尾へ追記（定型文・呼び出し群の挿入口。既存本文があれば改行を挟む）。
  const appendToSection = (sectionId: string, text: string) => {
    void commit((cur) => {
      const before = String(cur.sectionText[sectionId] ?? '');
      const next = before === '' ? text : `${before}\n${text}`;
      return { sectionText: { ...cur.sectionText, [sectionId]: next } };
    });
  };

  // 定型清書: 空の自由本文を正常文で埋めた合成結果を清書欄へ（保存値は最新 subject から合成）。
  const onPresetClean = () => {
    if (!template) return;
    void commit((cur) => ({ confirmedNote: composePresetClean(cur, template) }))
      .then(() => toast.show(t('detail.presetCleanDone'), 'success'))
      .catch(() => undefined); // 失敗通知は commit 側
  };

  // コピー / QR は「確定値を読む」操作。直前の blur 保存の完了を待ってから最新値を読む。
  const onCopy = () => {
    void pendingSubjectWrites().then(() => {
      const cur = getSubject(subjectId);
      const text = cur ? cur.confirmedNote : '';
      try {
        void navigator.clipboard.writeText(text).then(
          () => toast.show(t('detail.copied'), 'success'),
          () => toast.show(t('detail.copyFailed'), 'error'),
        );
      } catch {
        toast.show(t('detail.copyFailed'), 'error');
      }
    });
  };

  const onQr = () => {
    void pendingSubjectWrites().then(() => {
      const cur = getSubject(subjectId);
      if (!cur || cur.confirmedNote.trim() === '') {
        toast.show(t('detail.qrEmpty'), 'info');
        return;
      }
      setQrOpen(true);
    });
  };

  const doArchive = () => {
    setConfirmArchive(false);
    void pendingSubjectWrites()
      .then(() => archiveSubject(subjectId))
      .then(() => onBack())
      .catch(notifyFail); // 失敗時はこの画面に留まる（fail-closed）
  };

  return (
    <div className="tm-screen">
      <AppHeader
        left={
          <Button variant="ghost" onClick={onBack}>
            {t('detail.back')}
          </Button>
        }
        center={
          <button
            type="button"
            style={nameButtonStyle}
            aria-haspopup="dialog"
            onClick={() => setEditOpen(true)}
          >
            {subject.name || t('home.untitledSubject')}
          </button>
        }
        right={
          <IconButton
            label={t('detail.edit')}
            aria-haspopup="dialog"
            onClick={() => setEditOpen(true)}
          >
            <Icon name="edit" />
          </IconButton>
        }
      />

      <main className="tm-main">
        {/* ステータス（5色ピッカー。書き込みは他と同じ直列キュー経由） */}
        <section className="tm-card">
          <StatusPicker
            value={subject.status}
            onChange={(s) => void commit(() => ({ status: s }))}
          />
        </section>

        {/* 問題リスト（1 行 = 1 問題。複数行可・2 行目以降は経過などの補足） */}
        <section className="tm-card">
          <div className="tm-card-title">
            <span>{t('detail.problems')}</span>
          </div>
          <p style={hintStyle}>{t('detail.problemsHint')}</p>
          {subject.problems.length === 0 ? (
            <p style={mutedStyle}>{t('detail.problemsEmpty')}</p>
          ) : null}
          {subject.problems.map((problem, i) => (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}
            >
              <span style={{ fontWeight: 600, paddingTop: 10, flex: 'none' }}>#{i + 1}</span>
              <DraftTextarea
                value={problem}
                ariaLabel={`${t('detail.problems')} #${i + 1}`}
                style={{ flex: '1 1 auto', minWidth: 0 }}
                onCommit={(next) =>
                  commit((cur) => {
                    const problems = [...cur.problems];
                    problems[i] = next;
                    return { problems };
                  })
                }
              />
              <IconButton
                label={`${t('common.delete')} #${i + 1}`}
                onClick={() =>
                  void commit((cur) => ({ problems: cur.problems.filter((_, idx) => idx !== i) }))
                }
              >
                <Icon name="delete" />
              </IconButton>
            </div>
          ))}
          <Button
            style={{ marginTop: 8 }}
            onClick={() => void commit((cur) => ({ problems: [...cur.problems, ''] }))}
          >
            {t('detail.problemsAdd')}
          </Button>
        </section>

        {/* 申し送り・継続メモ（ラウンドをまたいで残る） */}
        <section className="tm-card">
          <div className="tm-card-title">
            <span>{t('detail.handover')}</span>
          </div>
          <DraftTextarea
            value={subject.handover}
            ariaLabel={t('detail.handover')}
            onCommit={(next) => commit(() => ({ handover: next }))}
          />
        </section>

        {/* 有効テンプレートのセクション */}
        {template?.sections.map((section) => {
          const alwaysGroups = section.groups.filter((g) => g.display === 'always');
          const oncallGroups = section.groups.filter((g) => g.display === 'oncall');
          return (
            <section key={section.id} className="tm-card">
              <div className="tm-card-title">
                <span>{section.title || t('detail.sectionFree')}</span>
              </div>
              {alwaysGroups.map((g) => (
                <GroupFormCard key={g.id} subject={subject} group={g} />
              ))}
              {oncallGroups.length > 0 ? (
                <div className="tm-chip-row">
                  {oncallGroups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className="tm-chip"
                      aria-haspopup="dialog"
                      onClick={() => setOncall({ sectionId: section.id, group: g })}
                    >
                      {g.name || t('detail.noteInput')}
                    </button>
                  ))}
                </div>
              ) : null}
              {section.freeText && snippets.length > 0 ? (
                <SnippetPicker
                  snippets={snippets}
                  onInsert={(body) => appendToSection(section.id, body)}
                />
              ) : null}
              {section.freeText ? (
                <div style={{ marginTop: 8 }}>
                  <DraftTextarea
                    value={String(subject.sectionText[section.id] ?? '')}
                    ariaLabel={section.title || t('detail.sectionFree')}
                    onCommit={(next) =>
                      commit((cur) => ({
                        sectionText: { ...cur.sectionText, [section.id]: next },
                      }))
                    }
                  />
                </div>
              ) : null}
            </section>
          );
        })}

        {/* 清書（QR に出す最終本文。定型清書はたたき台であり、人間が確認・修正する） */}
        <section className="tm-card">
          <div className="tm-card-title">
            <span>{t('detail.confirmedNote')}</span>
            {template ? <Button onClick={onPresetClean}>{t('detail.presetClean')}</Button> : null}
          </div>
          <DraftTextarea
            value={subject.confirmedNote}
            placeholder={t('detail.confirmedNotePlaceholder')}
            ariaLabel={t('detail.confirmedNote')}
            onCommit={(next) => commit(() => ({ confirmedNote: next }))}
          />
          <div className="tm-chip-row">
            <Button onClick={onCopy}>
              <Icon name="memo" size={18} />
              {t('detail.copy')}
            </Button>
            <Button onClick={onQr}>
              <Icon name="qr" size={18} />
              {t('detail.qr')}
            </Button>
          </div>
        </section>
      </main>

      {/* 下部バー: アーカイブへ移動（ソフトデリート。アーカイブ画面から戻せる） */}
      <div className="tm-bottom-bar">
        <Button onClick={() => setConfirmArchive(true)}>
          <Icon name="archive" size={18} />
          {t('detail.archive')}
        </Button>
      </div>

      {editOpen ? <SubjectEditPopup subject={subject} onClose={() => setEditOpen(false)} /> : null}
      {oncall ? (
        <OncallSheet
          group={oncall.group}
          onInsert={(text) => appendToSection(oncall.sectionId, text)}
          onClose={() => setOncall(null)}
        />
      ) : null}
      {qrOpen ? <QrDialog text={subject.confirmedNote} onClose={() => setQrOpen(false)} /> : null}
      {confirmArchive ? (
        <ConfirmDialog
          title={t('detail.archiveConfirmTitle')}
          body={t('detail.archiveConfirmBody')}
          confirmLabel={t('detail.archive')}
          cancelLabel={t('common.cancel')}
          onConfirm={doArchive}
          onCancel={() => setConfirmArchive(false)}
        />
      ) : null}
    </div>
  );
}
