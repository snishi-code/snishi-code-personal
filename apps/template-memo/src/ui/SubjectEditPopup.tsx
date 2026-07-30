/*
 * 対象情報の編集ダイアログ（名前・管理ID・位置・グループ・タグ）。
 * フィールドはローカル state で編集し、「保存」で 1 patch にまとめて確定する
 * （fail-closed: 保存失敗時はダイアログを開いたまま toast 通知 = 編集内容を失わない）。
 */
import { useState, type CSSProperties } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Modal } from '@snishi/foundation/ui/Modal';
import { useToast } from '@snishi/foundation/ui/toast';
import { sortedGroups, subjectsInGroup } from '../data/store';
import type { Subject } from '../domain/types';
import { errorText, t } from '../i18n';
import { commitSubjectPatch, type SubjectPatch } from './GroupFormCard';
import { useStore } from './useStore';

// グループ select の「未分類」番兵値。実グループ id は newId('grp') 由来なので衝突しない。
const GROUP_NONE = '';

// タグ選択チップの選択表示（HomeView の FilterChip と同じ見た目に揃える）。
const chipSelectedStyle: CSSProperties = {
  background: 'var(--primary-fill)',
  borderColor: 'var(--primary-fill)',
  color: 'var(--on-primary)',
};

export function SubjectEditPopup({ subject, onClose }: { subject: Subject; onClose: () => void }) {
  const state = useStore();
  const toast = useToast();
  const [name, setName] = useState(subject.name);
  const [code, setCode] = useState(subject.code);
  const [location, setLocation] = useState(subject.location);
  const [groupId, setGroupId] = useState(subject.groupId ?? GROUP_NONE);
  const [tagIds, setTagIds] = useState<string[]>(subject.tagIds);

  const groups = sortedGroups(state);
  const tags = [...state.settings.tags].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );

  const toggleTag = (tagId: string) => {
    setTagIds((cur) => (cur.includes(tagId) ? cur.filter((id) => id !== tagId) : [...cur, tagId]));
  };

  const save = () => {
    const nextGroupId = groupId === GROUP_NONE ? null : groupId;
    void commitSubjectPatch(subject.id, (cur) => {
      const patch: SubjectPatch = { name, code, location, tagIds };
      // グループ移動時は移動先の末尾へ付ける（store.moveSubject と同じ規則）。
      if (nextGroupId !== cur.groupId) {
        const peers = subjectsInGroup(nextGroupId);
        patch.groupId = nextGroupId;
        patch.sortOrder = Math.max(0, ...peers.map((x) => x.sortOrder)) + 1;
      }
      return patch;
    })
      .then(onClose)
      .catch((e: unknown) => toast.show(errorText(e, 'toast.saveFailed'), 'error'));
  };

  return (
    <Modal
      title={t('detail.edit')}
      onClose={onClose}
      variant="dialog"
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextInput label={t('detail.name')} value={name} onChange={setName} />
      <TextInput label={t('detail.code')} value={code} onChange={setCode} />
      <TextInput label={t('detail.location')} value={location} onChange={setLocation} />
      <SelectInput
        label={t('detail.group')}
        value={groupId}
        onChange={setGroupId}
        options={[
          { value: GROUP_NONE, label: t('home.noGroup') },
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      {tags.length > 0 ? (
        <div className="field">
          <span className="field__label">{t('detail.tags')}</span>
          <div className="tm-chip-row" role="group" aria-label={t('detail.tags')}>
            {tags.map((tag) => {
              const selected = tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className="tm-chip"
                  aria-pressed={selected}
                  style={selected ? chipSelectedStyle : undefined}
                  onClick={() => toggleTag(tag.id)}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
