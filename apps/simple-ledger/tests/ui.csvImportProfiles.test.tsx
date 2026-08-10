/*
 * CSV 取込 — プロファイル管理（§1-1）と AI プロファイルビルダー（§6）の UI テスト。
 *  - 管理: 削除（組み込みも可・binding/decision は残る旨の確認）→「組み込みプロファイルを復元」
 *    で戻る（冪等）／JSON 貼付追加（不正 JSON・未知キーは fail-closed でエラー表示・部分保存なし）
 *  - ビルダー: 合成 CSV → マスク/除外トグルで送信プレビューが変わる → 依頼文に injection 対策
 *    文言とマスク後の値だけが含まれる（実値が漏れない）→ 返書貼付 → 検証エラー →
 *    正しい返書 → 全行勘定の件数会計プレビュー → 保存 → 取込フローへの導線 + 一覧に出る
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { CsvImport } from '../src/ui/screens/CsvImport';
import { LedgerProvider } from '../src/state/store';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import { loadLedger } from '../src/data/repository';
import { PAYPAY_DSL, PAYPAY_PROFILE_ID } from '../src/domain/importProfilePresets';
import { PROMPT_INJECTION_GUARD } from '../src/domain/importPrompt';
import { UI } from '../src/ui-contract';
import './setup';

beforeAll(() => {
  patchDialogIfNeeded();
});

afterEach(() => {
  cleanup();
  _resetOverlaysForTests();
});

function q(dataUi: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-ui="${dataUi}"]`);
}

function qa(dataUi: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-ui="${dataUi}"]`)];
}

function renderScreen() {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <CsvImport onOpenEntry={() => undefined} />
      </LedgerProvider>
    </ToastProvider>,
  );
}

/** プロファイルタブを開いて一覧（または空表示）が出るまで待つ。 */
async function openProfilesTab(): Promise<void> {
  await waitFor(() => {
    expect(q(UI.csvImport.tabProfiles)).not.toBeNull();
  });
  fireEvent.click(q(UI.csvImport.tabProfiles)!);
  await waitFor(() => {
    expect(q(UI.csvImport.profilesRestore)).not.toBeNull();
  });
}

/* ── ビルダー用の合成 CSV（PayPay ではない未知フォーマット・全 5 行） ── */

const BUILDER_CSV = [
  '日付,内容,金額,取引先',
  '2026/08/01,買い物,-1200,スーパーA',
  '2026/08/02,給料,50000,勤務先B',
  '2026/08/03,対象外,0,ゴミ',
  '2026/08/04,手数料,-100,銀行C',
  '2026/08/05,壊れ,x,銀行C',
].join('\n');

/** 上の CSV に対する「正しい返書」の DSL（skip 1 行・error 1 行・正規化 3 行になる）。 */
const GOOD_DSL = {
  dslVersion: 1,
  fileFormat: { encoding: 'utf-8', delimiter: ',', headerRowIndex: 0 },
  columns: {
    date: { column: '日付', format: 'YYYY/MM/DD' },
    amount: { mode: 'signed', column: '金額', positiveDirection: 'inflow' },
    description: { columns: ['内容', '取引先'] },
  },
  skipRules: [{ when: { op: 'eq', column: '内容', value: '対象外' }, reason: '対象外' }],
  kindRules: [
    { when: { op: 'prefix', column: '金額', value: '-' }, kind: '支出' },
    { when: { op: 'not', condition: { op: 'prefix', column: '金額', value: '-' } }, kind: '収入' },
  ],
};

function csvFile(text: string, name = 'unknown-bank.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

function promptText(): string {
  const area = q(UI.csvImport.builderPrompt) as HTMLTextAreaElement | null;
  expect(area).not.toBeNull();
  return area!.value;
}

/** 列名 → マスク/除外セレクトを引く（aria-label = 「列ごとの送信設定: <列名>」）。 */
function maskSelectOf(column: string): HTMLSelectElement {
  const select = within(q(UI.csvImport.builderMaskList)!).getByLabelText(
    `列ごとの送信設定: ${column}`,
  );
  return select as HTMLSelectElement;
}

/** `.kv` 行（ラベル + 値）から値テキストを読む。 */
function kvValue(scope: Element, label: string): string | undefined {
  for (const row of scope.querySelectorAll('.kv')) {
    const spans = row.querySelectorAll('span');
    if (spans[0]?.textContent === label) return spans[1]?.textContent ?? undefined;
  }
  return undefined;
}

describe('プロファイル管理 — 削除と組み込み復元（§1-1）', () => {
  it('組み込みを削除 → 復元ボタンで原本へ戻る（もう一度押しても冪等）', async () => {
    await loadLedger();
    renderScreen();
    await openProfilesTab();

    // 一覧: 組み込みバッジ + dslVersion / digest 短縮のメタ表示。
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(1);
    });
    const row = qa(UI.csvImport.profileRow)[0]!;
    expect(row.textContent).toContain('組み込み');
    expect(row.textContent).toContain('PayPay');
    await waitFor(() => {
      expect(row.textContent).toMatch(/DSL v1・[0-9a-f]{8}/);
    });

    // 削除（確認ダイアログに「binding / decision は残る」旨が出る）。
    fireEvent.click(within(row).getByLabelText(/^削除: /));
    await waitFor(() => {
      expect(q(UI.csvImport.profileDeleteConfirm)).not.toBeNull();
    });
    expect(q(UI.csvImport.profileDeleteConfirm)!.textContent).toContain(
      '取込元の設定と決定済みの判定は残る',
    );
    fireEvent.click(
      within(q(UI.csvImport.profileDeleteConfirm)!).getByRole('button', { name: '削除' }),
    );
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(0);
    });
    expect(document.body.textContent).toContain('プロファイルがありません');
    expect((await loadLedger()).importProfiles).toHaveLength(0);

    // 復元 → 組み込みが固定 ID で戻る。
    fireEvent.click(q(UI.csvImport.profilesRestore)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(1);
    });
    const restored = await loadLedger();
    expect(restored.importProfiles).toHaveLength(1);
    expect(restored.importProfiles[0]!.id).toBe(PAYPAY_PROFILE_ID);
    expect(restored.importProfiles[0]!.builtin).toBeDefined();

    // 冪等: もう一度押しても増えない・同じ ID のまま。
    fireEvent.click(q(UI.csvImport.profilesRestore)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(1);
    });
    const again = await loadLedger();
    expect(again.importProfiles).toHaveLength(1);
    expect(again.importProfiles[0]!.id).toBe(PAYPAY_PROFILE_ID);
  });
});

describe('プロファイル管理 — JSON 貼付での追加（fail-closed・§1-1）', () => {
  it('不正 JSON / 未知キーはエラー表示のみで部分保存なし・正しい JSON で一覧に出る', async () => {
    await loadLedger();
    renderScreen();
    await openProfilesTab();

    fireEvent.click(q(UI.csvImport.profilesPasteOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)).not.toBeNull();
    });
    fireEvent.change(q(UI.csvImport.pasteName)!, { target: { value: '手貼りプロファイル' } });

    // ① JSON として読めない → エラー表示・保存されない。
    fireEvent.change(q(UI.csvImport.pasteJson)!, { target: { value: 'not json' } });
    fireEvent.click(q(UI.csvImport.pasteSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)!.textContent).toContain('JSON として読み取れません');
    });
    expect((await loadLedger()).importProfiles).toHaveLength(1);

    // ② 未知キー → strict 検証で拒否（黙って strip しない）。
    fireEvent.change(q(UI.csvImport.pasteJson)!, {
      target: { value: JSON.stringify({ ...PAYPAY_DSL, bogus: true }) },
    });
    fireEvent.click(q(UI.csvImport.pasteSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)!.textContent).toContain('DSL の検証に失敗しました');
    });
    expect((await loadLedger()).importProfiles).toHaveLength(1);

    // ③ 正しい JSON → 保存されて一覧に出る（ユーザー定義 = 組み込み印なし）。
    fireEvent.change(q(UI.csvImport.pasteJson)!, {
      target: { value: JSON.stringify(PAYPAY_DSL) },
    });
    fireEvent.click(q(UI.csvImport.pasteSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)).toBeNull();
    });
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(2);
    });
    const ledger = await loadLedger();
    expect(ledger.importProfiles).toHaveLength(2);
    const added = ledger.importProfiles.find((p) => p.name === '手貼りプロファイル');
    expect(added).toBeDefined();
    expect(added!.builtin).toBeUndefined();
  });
});

describe('AI プロファイルビルダー（§6）', () => {
  it('マスク開示 → 依頼文 → 返書検証（エラー→成功）→ 全行勘定プレビュー → 保存 → 取込導線', async () => {
    await loadLedger();
    renderScreen();
    await openProfilesTab();

    // ビルダーを開いて未知 CSV を選択。
    fireEvent.click(q(UI.csvImport.builderOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builder)).not.toBeNull();
    });
    fireEvent.change(q(UI.csvImport.builderFileInput)!, {
      target: { files: [csvFile(BUILDER_CSV)] },
    });
    await waitFor(() => {
      expect(q(UI.csvImport.builderMaskList)).not.toBeNull();
    });

    // 送信内容の完全プレビュー（= 依頼文全文）: injection 対策文言 + 実値が入っている。
    expect(promptText()).toContain(PROMPT_INJECTION_GUARD);
    expect(promptText()).toContain('スーパーA');
    expect(promptText()).toContain('買い物');

    // 取引先列をマスク → 実値が消えて *** に置き換わる（他列の実値は残る）。
    fireEvent.change(maskSelectOf('取引先'), { target: { value: 'mask' } });
    expect(promptText()).not.toContain('スーパーA');
    expect(promptText()).not.toContain('勤務先B');
    expect(promptText()).not.toContain('銀行C');
    expect(promptText()).toContain('***');
    expect(promptText()).toContain('買い物');

    // 日付列を除外 → 列ごと送られない（ヘッダーからも値からも消える）。
    fireEvent.change(maskSelectOf('日付'), { target: { value: 'omit' } });
    expect(promptText()).not.toContain('2026/08/01');
    expect(promptText()).toContain('内容,金額,取引先');
    fireEvent.change(maskSelectOf('日付'), { target: { value: 'raw' } });
    expect(promptText()).toContain('2026/08/01');

    // 返書① JSON でないテキスト → fail-closed のエラー表示・プレビューは出ない。
    fireEvent.change(q(UI.csvImport.builderReply)!, { target: { value: 'できませんでした。' } });
    fireEvent.click(q(UI.csvImport.builderCheck)!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('JSON として読み取れません');
    });
    expect(q(UI.csvImport.builderPreview)).toBeNull();

    // 返書② 形の壊れた DSL → strict 検証エラー。
    fireEvent.change(q(UI.csvImport.builderReply)!, {
      target: { value: '{"dslVersion":1}' },
    });
    fireEvent.click(q(UI.csvImport.builderCheck)!);
    await waitFor(() => {
      expect(document.body.textContent).toContain('DSL の検証に失敗しました');
    });
    expect(q(UI.csvImport.builderPreview)).toBeNull();

    // 返書③ 正しい返書（```json フェンス込みの文章）→ 実適用プレビュー。
    const reply = [
      'できました。以下の設定を使ってください。',
      '```json',
      JSON.stringify(GOOD_DSL, null, 2),
      '```',
      '以上です。',
    ].join('\n');
    fireEvent.change(q(UI.csvImport.builderReply)!, { target: { value: reply } });
    fireEvent.click(q(UI.csvImport.builderCheck)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builderPreview)).not.toBeNull();
    });

    // 件数会計 = 全行勘定（総行数 5 = 取込対象 3 + skip 1 + error 1）。skip は理由別。
    const preview = q(UI.csvImport.builderPreview)!;
    expect(kvValue(preview, '総行数')).toBe('5');
    expect(kvValue(preview, '取込対象')).toBe('3');
    expect(kvValue(preview, 'スキップ')).toBe('1');
    expect(kvValue(preview, 'エラー')).toBe('1');
    expect(preview.textContent).toContain('条件スキップ（対象外）');
    // 正規化行の先頭数行も見える。
    expect(preview.textContent).toContain('買い物 スーパーA');

    // 名前を付けて保存 → 取込フローへの導線（profile 選択済み・binding セットアップ gate）。
    fireEvent.change(q(UI.csvImport.builderName)!, { target: { value: '銀行CSV' } });
    fireEvent.click(q(UI.csvImport.builderSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.setupOpen)).not.toBeNull();
    });
    const ledger = await loadLedger();
    expect(ledger.importProfiles).toHaveLength(2);
    const saved = ledger.importProfiles.find((p) => p.name === '銀行CSV');
    expect(saved).toBeDefined();
    expect(saved!.builtin).toBeUndefined();
    // 取込タブの profile セレクトに保存した profile が選択されている。
    expect((q(UI.csvImport.profile) as HTMLSelectElement).value).toBe(saved!.id);
    // ファイルもビルダーで選んだものが引き継がれている。
    expect(document.body.textContent).toContain('unknown-bank.csv');

    // プロファイルタブへ戻ると一覧にも出る。
    fireEvent.click(q(UI.csvImport.tabProfiles)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(2);
    });
  });
});
