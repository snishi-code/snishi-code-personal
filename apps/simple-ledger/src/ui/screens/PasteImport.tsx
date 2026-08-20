/*
 * 仕訳の貼り付け一括登録（v13.10）。
 *
 * テキスト貼り付けの受け口**だけ**を作る（ファイル取込ではない = 「CSV ファイル取込の
 * 再実装禁止」の決定はそのまま・別機構）。テキストの生成はユーザー側の AI に丸投げし、
 * 重複検知もアプリではやらない（作者決定 2026-08-19 受信箱）。
 *
 * 流れ: 貼り付け → 登録 → 件数の確認ダイアログ → 全行を単一 tx で保存（1 行でも
 * エラーなら行番号付きで全部列挙し、1 件も登録しない）→ 成功でテキストを消して
 * ホームへ（onDone・作者決定 2026-08-20）。個別の手直しは仕訳一覧の通常編集で行う。
 */
import { useState } from 'react';
import { TextArea } from '@snishi/foundation/ui/Field';
import { Icon } from '@snishi/foundation/ui/Icon';
import { ConfirmDialog } from '../overlays';
import { useLedger } from '../../state/store';
import { parsePasteText, PASTE_MAX_ROWS, type PasteError } from '../pasteImport';
import type { SimpleEntryInput } from '../../domain/entry';
import { t } from '../../i18n';
import { UI } from '../../ui-contract';

function errorMessage(error: PasteError): string {
  switch (error.kind) {
    case 'too-many':
      return t('pasteImport.error.tooMany', { max: PASTE_MAX_ROWS, count: error.count });
    case 'field-count':
      return t('pasteImport.error.fieldCount', { line: error.line });
    case 'date':
      return t('pasteImport.error.date', { line: error.line });
    case 'description':
      return t('pasteImport.error.description', { line: error.line });
    case 'amount':
      return t('pasteImport.error.amount', { line: error.line });
    case 'unknown-account':
      return t('pasteImport.error.unknownAccount', { line: error.line, name: error.name });
    case 'ambiguous-account':
      return t('pasteImport.error.ambiguousAccount', { line: error.line, name: error.name });
    case 'account-period':
      return t('pasteImport.error.accountPeriod', { line: error.line, name: error.name });
    case 'same-account':
      return t('pasteImport.error.sameAccount', { line: error.line });
  }
}

export function PasteImport({ onDone }: { onDone: () => void }) {
  const { ledger, createEntries } = useLedger();
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [pendingRows, setPendingRows] = useState<SimpleEntryInput[] | null>(null);

  const submit = () => {
    const result = parsePasteText(text, ledger?.accounts ?? []);
    if (result.errors.length > 0) {
      setMessages(result.errors.map(errorMessage));
      return;
    }
    if (result.rows.length === 0) {
      setMessages([t('pasteImport.error.empty')]);
      return;
    }
    setMessages([]);
    setPendingRows(result.rows);
  };

  return (
    <section aria-labelledby="paste-import-title" data-ui={UI.pasteImport.view}>
      <h1 className="screen-title" id="paste-import-title">
        {t('pasteImport.title')}
      </h1>
      <div className="card card--pad stack">
        <p className="field__hint">{t('pasteImport.desc')}</p>
        <p className="field__hint">
          {t('pasteImport.format')}
          <br />
          {t('pasteImport.example')}
        </p>
        <p className="field__hint">{t('pasteImport.nameHint')}</p>
        <TextArea
          label={t('pasteImport.textLabel')}
          value={text}
          onChange={setText}
          placeholder={t('pasteImport.example')}
          dataUi={UI.pasteImport.text}
        />
        {messages.length > 0 ? (
          <div className="field__error" role="alert" data-ui={UI.pasteImport.errors}>
            <Icon name="alert" size={14} />
            <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* 台帳ロード前は科目名を解決できない（空の科目一覧で全行 unknown になる）ため無効。 */}
        <button
          type="button"
          className="btn btn--block"
          onClick={submit}
          disabled={!ledger}
          data-ui={UI.pasteImport.submit}
        >
          <Icon name="upload" size={18} />
          {t('pasteImport.submit')}
        </button>
      </div>
      {pendingRows ? (
        <ConfirmDialog
          title={t('pasteImport.confirmTitle')}
          body={t('pasteImport.confirmBody', { count: pendingRows.length })}
          confirmLabel={t('pasteImport.submit')}
          dataUi={UI.dialog.confirm}
          onCancel={() => setPendingRows(null)}
          onConfirm={async () => {
            try {
              await createEntries(pendingRows);
            } catch {
              // 失敗 = 未保存: 閉じない（エラーは store が toast 済み・再試行できる）。
              return;
            }
            setPendingRows(null);
            setText('');
            onDone();
          }}
        />
      ) : null}
    </section>
  );
}
