/*
 * テンプレート編集画面。設定画面のローカル state から呼ばれる（ルートは増やさない）。
 * draft をローカル state に deep copy し、保存時に normalizeTemplate を通してから
 * saveTemplate する（壊れた構造は正規化で落ちる。全滅なら保存せず通知 = fail-closed）。
 * 美しさより網羅を優先した密なフォーム。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { AppHeader } from '@snishi/foundation/ui/AppHeader';
import { Button } from '@snishi/foundation/ui/Button';
import { SelectInput, TextInput } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { IconButton } from '@snishi/foundation/ui/IconButton';
import { useToast } from '@snishi/foundation/ui/toast';
import { newId } from '../data/constants';
import { saveTemplate } from '../data/store';
import { normalizeTemplate } from '../domain/template';
import type { Template, TemplateGroup, TemplateItem, TemplateSection } from '../domain/template';
import { errorText, t, type MessageKey } from '../i18n';

/**
 * ja.ts に未追加のキーを参照する暫定ヘルパ。未追加の間はキー名がそのまま表示される
 * （foundation createI18n の fail-visible 仕様）。ja.ts へキーを足せばコード変更なしで
 * 文言が出る。必要キーは親タスクへ missingI18nKeys として報告済み。
 */
function tPending(key: string): string {
  return t(key as MessageKey);
}

// ============================
// 小さな共有部品（このファイル内のみ）
// ============================

/** チェックボックス行（44px タップ領域・ラベルは t() 済み文字列を渡す）。 */
function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 20, height: 20, flex: 'none' }}
      />
      <span>{label}</span>
    </label>
  );
}

/** ↑↓・削除の共通操作列（sections / groups / items で使い回す）。 */
function RowTools({
  onUp,
  onDown,
  onDelete,
  upDisabled,
  downDisabled,
}: {
  onUp: () => void;
  onDown: () => void;
  onDelete: () => void;
  upDisabled: boolean;
  downDisabled: boolean;
}) {
  return (
    <span style={{ display: 'flex', gap: 4, flex: 'none' }}>
      <IconButton label={t('tpl.moveUp')} onClick={onUp} disabled={upDisabled}>
        ↑
      </IconButton>
      <IconButton label={t('tpl.moveDown')} onClick={onDown} disabled={downDisabled}>
        ↓
      </IconButton>
      <IconButton label={t('tpl.delete')} onClick={onDelete}>
        <Icon name="delete" size={20} />
      </IconButton>
    </span>
  );
}

/** カード内の小見出し + 操作列の行。 */
function CardHead({ title, tools }: { title: string; tools: ReactNode }) {
  return (
    <div className="tm-card-title">
      <span>{title}</span>
      {tools}
    </div>
  );
}

// ============================
// 選択肢（joiner / labelSep）
// ============================

/** 項目間の区切りの候補。値は合成にそのまま使われる文字列。 */
const JOINER_OPTIONS: { value: string; labelKey: string }[] = [
  { value: '\n', labelKey: 'tpl.joinerNewline' },
  { value: ', ', labelKey: 'tpl.joinerCommaSpace' },
  { value: '、', labelKey: 'tpl.joinerToten' },
  { value: '-', labelKey: 'tpl.joinerHyphen' },
  { value: ' ', labelKey: 'tpl.joinerSpace' },
];

/** ラベルと値の区切りの候補。 */
const LABEL_SEP_OPTIONS: { value: string; labelKey: string }[] = [
  { value: '：', labelKey: 'tpl.labelSepColon' },
  { value: ' ', labelKey: 'tpl.labelSepSpace' },
  { value: '', labelKey: 'tpl.labelSepNone' },
];

/**
 * select 用の options を作る。現在値が候補に無い場合（インポートした独自区切り等）は
 * その値を JSON 表記のまま先頭へ足し、選択状態が黙って壊れないようにする。
 */
function sepOptions(candidates: { value: string; labelKey: string }[], current: string) {
  const options = candidates.map((c) => ({ value: c.value, label: tPending(c.labelKey) }));
  if (!candidates.some((c) => c.value === current)) {
    options.unshift({ value: current, label: JSON.stringify(current) });
  }
  return options;
}

// ============================
// 新規行の初期値
// ============================

function newItem(): TemplateItem {
  return { id: newId('itm'), label: '', kind: 'text' };
}

function newGroup(): TemplateGroup {
  // items が空の群は保存時の正規化で落ちるため、最初から空項目を 1 つ入れておく。
  return {
    id: newId('grp'),
    name: '',
    display: 'always',
    joiner: '\n',
    labelSep: '：',
    titleWrap: '',
    items: [newItem()],
  };
}

function newSection(): TemplateSection {
  return { id: newId('sec'), title: '', keepWhenEmpty: false, freeText: true, groups: [] };
}

/** 配列の index 要素を dir 方向へ 1 つ動かす（範囲外は何もしない・破壊的）。 */
function moveInArray<T>(arr: T[], index: number, dir: -1 | 1): void {
  const j = index + dir;
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return;
  const [x] = arr.splice(index, 1);
  if (x !== undefined) arr.splice(j, 0, x);
}

// ============================
// 本体
// ============================

export function TemplateEditView({ template, onDone }: { template: Template; onDone: () => void }) {
  const toast = useToast();
  // deep copy して編集する（保存まで store には触らない）。
  const [draft, setDraft] = useState<Template>(
    () => JSON.parse(JSON.stringify(template)) as Template,
  );

  /** draft を clone → 書き換え → setState。フォームの全編集はこれを通す。 */
  const mutate = (fn: (d: Template) => void) => {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as Template;
      fn(next);
      return next;
    });
  };

  /** section を安全に引いて書き換える（並び替え直後の stale index を握りつぶさない）。 */
  const mutateSection = (sectionId: string, fn: (s: TemplateSection) => void) => {
    mutate((d) => {
      const s = d.sections.find((x) => x.id === sectionId);
      if (s) fn(s);
    });
  };

  const mutateGroup = (sectionId: string, groupId: string, fn: (g: TemplateGroup) => void) => {
    mutateSection(sectionId, (s) => {
      const g = s.groups.find((x) => x.id === groupId);
      if (g) fn(g);
    });
  };

  const onSave = async () => {
    // 正規化してから保存する。全 section が落ちる壊れ構造は保存しない（fail-closed）。
    const normalized = normalizeTemplate({ ...draft, updatedAt: Date.now() });
    if (!normalized) {
      toast.show(t('toast.saveFailed'), 'error');
      return;
    }
    try {
      await saveTemplate(normalized);
      toast.show(t('tpl.saved'));
      onDone();
    } catch (e) {
      toast.show(errorText(e, 'toast.saveFailed'), 'error');
    }
  };

  // ---------- item 1 行のフォーム ----------
  const renderItem = (
    sectionId: string,
    groupId: string,
    item: TemplateItem,
    index: number,
    count: number,
  ) => (
    <div
      key={item.id}
      style={{
        borderTop: '1px solid var(--border, #e2e8f0)',
        paddingTop: 8,
        marginTop: 8,
      }}
    >
      <CardHead
        title={`${t('tpl.items')} ${index + 1}`}
        tools={
          <RowTools
            upDisabled={index === 0}
            downDisabled={index === count - 1}
            onUp={() => mutateGroup(sectionId, groupId, (g) => moveInArray(g.items, index, -1))}
            onDown={() => mutateGroup(sectionId, groupId, (g) => moveInArray(g.items, index, 1))}
            onDelete={() =>
              mutateGroup(sectionId, groupId, (g) => {
                g.items = g.items.filter((x) => x.id !== item.id);
              })
            }
          />
        }
      />
      <TextInput
        label={t('tpl.itemLabel')}
        value={item.label}
        onChange={(v) =>
          mutateGroup(sectionId, groupId, (g) => {
            const it = g.items.find((x) => x.id === item.id);
            if (it) it.label = v;
          })
        }
      />
      <SelectInput
        label={t('tpl.itemKind')}
        value={item.kind}
        options={[
          { value: 'text', label: t('tpl.itemKindText') },
          { value: 'number', label: t('tpl.itemKindNumber') },
          { value: 'fraction', label: t('tpl.itemKindFraction') },
        ]}
        onChange={(v) =>
          mutateGroup(sectionId, groupId, (g) => {
            const it = g.items.find((x) => x.id === item.id);
            if (it) it.kind = v === 'number' || v === 'fraction' ? v : 'text';
          })
        }
      />
      {item.kind !== 'text' ? (
        <TextInput
          label={t('tpl.itemUnit')}
          value={item.unit ?? ''}
          onChange={(v) =>
            mutateGroup(sectionId, groupId, (g) => {
              const it = g.items.find((x) => x.id === item.id);
              if (it) it.unit = v;
            })
          }
        />
      ) : (
        <TextInput
          label={t('tpl.itemNormal')}
          value={item.normal ?? ''}
          onChange={(v) =>
            mutateGroup(sectionId, groupId, (g) => {
              const it = g.items.find((x) => x.id === item.id);
              if (it) it.normal = v;
            })
          }
        />
      )}
      <CheckRow
        label={tPending('tpl.itemShowLabel')}
        checked={item.showLabel !== false}
        onChange={(v) =>
          mutateGroup(sectionId, groupId, (g) => {
            const it = g.items.find((x) => x.id === item.id);
            if (!it) return;
            // 未定義 = true 扱いなので、ON は showLabel を消して既定へ戻す。
            if (v) delete it.showLabel;
            else it.showLabel = false;
          })
        }
      />
    </div>
  );

  // ---------- group 1 つのフォーム ----------
  const renderGroup = (sectionId: string, group: TemplateGroup, index: number, count: number) => (
    <div className="tm-card" key={group.id}>
      <CardHead
        title={group.name !== '' ? group.name : `${t('tpl.groups')} ${index + 1}`}
        tools={
          <RowTools
            upDisabled={index === 0}
            downDisabled={index === count - 1}
            onUp={() => mutateSection(sectionId, (s) => moveInArray(s.groups, index, -1))}
            onDown={() => mutateSection(sectionId, (s) => moveInArray(s.groups, index, 1))}
            onDelete={() =>
              mutateSection(sectionId, (s) => {
                s.groups = s.groups.filter((x) => x.id !== group.id);
              })
            }
          />
        }
      />
      <TextInput
        label={t('tpl.groupName')}
        value={group.name}
        onChange={(v) => mutateGroup(sectionId, group.id, (g) => (g.name = v))}
      />
      <SelectInput
        label={t('tpl.groupDisplay')}
        value={group.display}
        options={[
          { value: 'always', label: t('tpl.groupDisplayAlways') },
          { value: 'oncall', label: t('tpl.groupDisplayOncall') },
        ]}
        onChange={(v) =>
          mutateGroup(
            sectionId,
            group.id,
            (g) => (g.display = v === 'oncall' ? 'oncall' : 'always'),
          )
        }
      />
      <SelectInput
        label={t('tpl.groupJoiner')}
        value={group.joiner}
        options={sepOptions(JOINER_OPTIONS, group.joiner)}
        onChange={(v) => mutateGroup(sectionId, group.id, (g) => (g.joiner = v))}
      />
      <SelectInput
        label={t('tpl.groupLabelSep')}
        value={group.labelSep}
        options={sepOptions(LABEL_SEP_OPTIONS, group.labelSep)}
        onChange={(v) => mutateGroup(sectionId, group.id, (g) => (g.labelSep = v))}
      />
      {group.items.map((item, i) => renderItem(sectionId, group.id, item, i, group.items.length))}
      <Button
        block
        onClick={() => mutateGroup(sectionId, group.id, (g) => g.items.push(newItem()))}
      >
        {t('tpl.itemAdd')}
      </Button>
    </div>
  );

  // ---------- section 1 つのフォーム ----------
  const renderSection = (section: TemplateSection, index: number, count: number) => (
    <section className="tm-card" key={section.id}>
      <CardHead
        title={section.title !== '' ? section.title : `${t('tpl.sections')} ${index + 1}`}
        tools={
          <RowTools
            upDisabled={index === 0}
            downDisabled={index === count - 1}
            onUp={() => mutate((d) => moveInArray(d.sections, index, -1))}
            onDown={() => mutate((d) => moveInArray(d.sections, index, 1))}
            onDelete={() =>
              mutate((d) => {
                d.sections = d.sections.filter((x) => x.id !== section.id);
              })
            }
          />
        }
      />
      <TextInput
        label={t('tpl.sectionTitle')}
        value={section.title}
        onChange={(v) => mutateSection(section.id, (s) => (s.title = v))}
      />
      <TextInput
        label={t('tpl.sectionNormal')}
        value={section.normal ?? ''}
        onChange={(v) => mutateSection(section.id, (s) => (s.normal = v))}
      />
      <CheckRow
        label={t('tpl.sectionKeepWhenEmpty')}
        checked={section.keepWhenEmpty}
        onChange={(v) => mutateSection(section.id, (s) => (s.keepWhenEmpty = v))}
      />
      <CheckRow
        label={t('tpl.sectionFreeText')}
        checked={section.freeText}
        onChange={(v) => mutateSection(section.id, (s) => (s.freeText = v))}
      />
      <h3 style={{ fontSize: '0.95rem', margin: '12px 0 0' }}>{t('tpl.groups')}</h3>
      {section.groups.map((g, i) => renderGroup(section.id, g, i, section.groups.length))}
      <Button block onClick={() => mutateSection(section.id, (s) => s.groups.push(newGroup()))}>
        {t('tpl.groupAdd')}
      </Button>
    </section>
  );

  return (
    <div className="tm-screen">
      <AppHeader
        left={
          <Button variant="ghost" onClick={onDone}>
            {t('tpl.cancel')}
          </Button>
        }
        center={<strong>{t('settings.templateEdit')}</strong>}
      />
      <main className="tm-main">
        <section className="tm-card">
          <TextInput
            label={t('tpl.name')}
            value={draft.name}
            onChange={(v) => mutate((d) => (d.name = v))}
          />
          <CheckRow
            label={t('tpl.includeProblems')}
            checked={draft.includeProblems}
            onChange={(v) => mutate((d) => (d.includeProblems = v))}
          />
          <CheckRow
            label={t('tpl.includeHandover')}
            checked={draft.includeHandover}
            onChange={(v) => mutate((d) => (d.includeHandover = v))}
          />
        </section>

        <h2 style={{ fontSize: '1rem', margin: '16px 0 0' }}>{t('tpl.sections')}</h2>
        {draft.sections.map((s, i) => renderSection(s, i, draft.sections.length))}
        <div style={{ marginTop: 12 }}>
          <Button block onClick={() => mutate((d) => d.sections.push(newSection()))}>
            {t('tpl.sectionAdd')}
          </Button>
        </div>
      </main>
      <div className="tm-bottom-bar">
        <Button variant="ghost" onClick={onDone}>
          {t('tpl.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void onSave()}>
          {t('tpl.save')}
        </Button>
      </div>
    </div>
  );
}
