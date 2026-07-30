/*
 * 呼び出し群（display='oncall'）の入力シート。チップから開き、GroupFormCard と同じ
 * 入力列を出すが、値は一時 state のみ（subject へ保存しない = 旧回診 quick の設計）。
 * 「本文へ挿入」で composeGroup した合成文を親へ渡し、セクション本文の末尾へ追記してもらう。
 */
import { useRef, useState } from 'react';
import { Button } from '@snishi/foundation/ui/Button';
import { Modal } from '@snishi/foundation/ui/Modal';
import { decidePresetToggle } from '../domain/formValues';
import { composeGroup, type TemplateGroup, type TemplateItem } from '../domain/template';
import type { NumericEntry, TextEntry } from '../domain/types';
import { t } from '../i18n';
import { ItemInputRow } from './GroupFormCard';

export function OncallSheet({
  group,
  onInsert,
  onClose,
}: {
  group: TemplateGroup;
  /** 合成文（hasValue のときだけ呼ばれる）。追記位置は親（DetailView）が決める。 */
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  // 一時値。挿入時は「挿入ボタンのタップで blur → 同期 commit」の順になるため、
  // setState を待たず読める ref を正本にする（state は再描画用の写し）。
  const valuesRef = useRef<Record<string, unknown>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});

  const write = (itemId: string, stored: TextEntry | NumericEntry | ''): void => {
    valuesRef.current = { ...valuesRef.current, [itemId]: stored };
    setValues(valuesRef.current);
  };

  // 正常文ワンタップ（一時値に対して同期判定。手入力は openEditor で守る）。
  const presetToggle = (item: TemplateItem) => (focusInput: () => void) => {
    const d = decidePresetToggle(valuesRef.current[item.id], item.normal);
    if (d.action === 'openEditor') {
      focusInput();
      return;
    }
    write(item.id, d.action === 'write' ? d.value : '');
  };

  const insert = () => {
    const { text, hasValue } = composeGroup(group, valuesRef.current);
    if (hasValue) onInsert(text);
    onClose(); // 全項目空なら挿入なしで閉じるだけ（空文を本文へ入れない）
  };

  return (
    <Modal
      title={group.name || t('detail.noteInput')}
      onClose={onClose}
      closeLabel={t('common.close')}
      footer={
        <Button variant="primary" block onClick={insert}>
          {t('detail.oncallInsert')}
        </Button>
      }
    >
      {group.items.map((item) => (
        <ItemInputRow
          key={item.id}
          item={item}
          rawValue={values[item.id]}
          onCommit={(stored) => write(item.id, stored)}
          onPresetToggle={
            item.kind === 'text' && item.normal !== undefined ? presetToggle(item) : undefined
          }
        />
      ))}
    </Modal>
  );
}
