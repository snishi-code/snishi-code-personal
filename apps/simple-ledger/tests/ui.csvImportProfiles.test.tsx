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
    // 理由は日本語で読める（zod の英語 message をそのまま出さない）。
    expect(q(UI.csvImport.pasteSheet)!.textContent).toContain('使えない項目があります（bogus）');
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

describe('プロファイル管理 — 作り直し（アーカイブ+新規・作者決定 2026-08-11・v9）', () => {
  it('既存を選ぶと旧をアーカイブして新規作成し、アーカイブ済みは取込選択に出ない', async () => {
    await loadLedger();
    renderScreen();
    await openProfilesTab();

    fireEvent.click(q(UI.csvImport.profilesPasteOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)).not.toBeNull();
    });
    // 保存方法: 「新規追加」のほか、既存の「作り直し（旧をアーカイブ）」が選べる（上書きは無い）。
    // 作り直し対象は ledger（IndexedDB 由来・非同期読込）から出るため、シート表示とは別に
    // 選択肢へ載るまで待つ（全体実行の負荷で顕在化する race・分離問題ではない）。
    await waitFor(() => {
      const target = q(UI.csvImport.pasteTarget) as HTMLSelectElement | null;
      expect(target).not.toBeNull();
      expect(
        [...target!.querySelectorAll('option')].some((o) => o.textContent?.includes('作り直し')),
      ).toBe(true);
    });
    const target = q(UI.csvImport.pasteTarget) as HTMLSelectElement;
    const options = [...target.querySelectorAll('option')];
    expect(options.some((o) => o.textContent?.includes('上書き'))).toBe(false);
    const replaceOption = options.find((o) => o.textContent?.includes('作り直し'));
    expect(replaceOption).toBeDefined();
    fireEvent.change(target, { target: { value: replaceOption!.value } });
    fireEvent.change(q(UI.csvImport.pasteName)!, { target: { value: 'PayPay 第2版' } });
    fireEvent.change(q(UI.csvImport.pasteJson)!, {
      target: { value: JSON.stringify(PAYPAY_DSL) },
    });
    fireEvent.click(q(UI.csvImport.pasteSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)).toBeNull();
    });

    // 一覧: 旧（組み込み印 + アーカイブ済みバッジ）と新規の 2 行で区別表示される。
    await waitFor(() => {
      expect(qa(UI.csvImport.profileRow)).toHaveLength(2);
    });
    const archivedRow = qa(UI.csvImport.profileRow).find((r) =>
      r.textContent?.includes('アーカイブ済み'),
    );
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.textContent).toContain('組み込み'); // 印は原本の側に残る
    const ledger = await loadLedger();
    expect(ledger.importProfiles.find((p) => p.id === PAYPAY_PROFILE_ID)?.archived).toBe(true);
    const next = ledger.importProfiles.find((p) => p.name === 'PayPay 第2版')!;
    expect(next.builtin).toBeUndefined(); // 作り直し側に組み込み印は付かない
    expect(next.archived).toBeUndefined();

    // 取込タブの profile セレクトにアーカイブ済みは出ない（新規だけが選べる）。
    fireEvent.click(q(UI.csvImport.tabFlow)!);
    await waitFor(() => {
      expect(q(UI.csvImport.profile)).not.toBeNull();
    });
    const importSelect = q(UI.csvImport.profile) as HTMLSelectElement;
    const selectable = [...importSelect.querySelectorAll('option')]
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(selectable).toEqual([next.id]);

    // 作り直し対象に選べるのも非アーカイブのみ（アーカイブ済みの再アーカイブは出ない）。
    fireEvent.click(q(UI.csvImport.tabProfiles)!);
    await waitFor(() => {
      expect(q(UI.csvImport.profilesPasteOpen)).not.toBeNull();
    });
    fireEvent.click(q(UI.csvImport.profilesPasteOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.pasteSheet)).not.toBeNull();
    });
    // 選択肢も ledger 由来のため、載るまで待ってから内訳を assert する（上と同じ race 対策）。
    await waitFor(() => {
      const reopened = q(UI.csvImport.pasteTarget) as HTMLSelectElement | null;
      expect(reopened).not.toBeNull();
      expect(
        [...reopened!.querySelectorAll('option')].some((o) => o.textContent?.includes('作り直し')),
      ).toBe(true);
    });
    const reopened = q(UI.csvImport.pasteTarget) as HTMLSelectElement;
    const labels = [...reopened.querySelectorAll('option')].map((o) => o.textContent ?? '');
    expect(labels.filter((l) => l.includes('作り直し'))).toHaveLength(1);
    expect(labels.some((l) => l.includes('PayPay 第2版'))).toBe(true);
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
    // 列名の幅 0 対策（項目10）: app.css の上書きが効くスコープクラスを持つ。
    expect(q(UI.csvImport.builderMaskList)!.classList.contains('csv-import__mask-list')).toBe(true);

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
    // 欠けている項目が日本語の場所名で分かる（AI に何を直させるかが読める）。
    expect(document.body.textContent).toContain('ファイル形式: 必須の項目がありません');
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

    // 名前を付けて保存。error 1 行が残っているため黙って保存されず、件数を明示した
    // 確認ダイアログが出る（項目2。fail-closed の意味 = error 行は取り込まれない、は不変）。
    fireEvent.change(q(UI.csvImport.builderName)!, { target: { value: '銀行CSV' } });
    fireEvent.click(q(UI.csvImport.builderSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builderSaveErrorsConfirm)).not.toBeNull();
    });
    const errorsConfirm = q(UI.csvImport.builderSaveErrorsConfirm)!;
    expect(errorsConfirm.textContent).toContain('エラー 1 行はこのプロファイルでは取り込めません');
    // キャンセルなら何も保存されない。
    fireEvent.click(within(errorsConfirm).getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => {
      expect(q(UI.csvImport.builderSaveErrorsConfirm)).toBeNull();
    });
    expect((await loadLedger()).importProfiles).toHaveLength(1);

    // 確認して保存 → 取込フローへの導線（profile 選択済み・binding セットアップ gate）。
    fireEvent.click(q(UI.csvImport.builderSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builderSaveErrorsConfirm)).not.toBeNull();
    });
    fireEvent.click(
      within(q(UI.csvImport.builderSaveErrorsConfirm)!).getByRole('button', { name: '保存する' }),
    );
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

  it('ファイル切替のレースガード: A 読込中に B を選ぶと A の応答は捨てられる（P1-3）', async () => {
    await loadLedger();
    renderScreen();
    await openProfilesTab();
    fireEvent.click(q(UI.csvImport.builderOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builder)).not.toBeNull();
    });

    // A: arrayBuffer を手動 resolve できる「遅い」ファイル（2 列ヘッダー）。
    const slowText = 'h1,h2\nA1,A2';
    const slowA = csvFile(slowText, 'slow-a.csv');
    let resolveA: ((buffer: ArrayBuffer) => void) | undefined;
    Object.defineProperty(slowA, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveA = resolve;
        }),
    });
    fireEvent.change(q(UI.csvImport.builderFileInput)!, { target: { files: [slowA] } });
    expect(resolveA).toBeDefined();

    // A の読込が終わらないうちに B（BUILDER_CSV・4 列）を選ぶ → B のマスク列一覧と依頼文。
    fireEvent.change(q(UI.csvImport.builderFileInput)!, {
      target: { files: [csvFile(BUILDER_CSV, 'fast-b.csv')] },
    });
    await waitFor(() => {
      expect(q(UI.csvImport.builderMaskList)).not.toBeNull();
    });
    expect(promptText()).toContain('日付,内容,金額,取引先');

    // 遅れて A の読込が完了しても、古い応答は捨てられて B の状態のまま（P1-3 の固定）。
    const encoded = new TextEncoder().encode(slowText);
    const bufferA = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(bufferA).set(encoded);
    resolveA!(bufferA);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(promptText()).toContain('日付,内容,金額,取引先');
    expect(promptText()).not.toContain('h1,h2');
  });

  it('エラー 0 件のプレビューなら確認ダイアログ無しで保存できる（項目2の回帰確認）', async () => {
    // BUILDER_CSV から error 行（金額 x）を除いた版 = 全行が正規化 or skip される。
    const cleanCsv = BUILDER_CSV.split('\n')
      .filter((line) => !line.includes('壊れ'))
      .join('\n');
    await loadLedger();
    renderScreen();
    await openProfilesTab();

    fireEvent.click(q(UI.csvImport.builderOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builder)).not.toBeNull();
    });
    fireEvent.change(q(UI.csvImport.builderFileInput)!, {
      target: { files: [csvFile(cleanCsv, 'clean-bank.csv')] },
    });
    await waitFor(() => {
      expect(q(UI.csvImport.builderMaskList)).not.toBeNull();
    });
    fireEvent.change(q(UI.csvImport.builderReply)!, {
      target: { value: JSON.stringify(GOOD_DSL) },
    });
    fireEvent.click(q(UI.csvImport.builderCheck)!);
    await waitFor(() => {
      expect(q(UI.csvImport.builderPreview)).not.toBeNull();
    });
    expect(kvValue(q(UI.csvImport.builderPreview)!, 'エラー')).toBe('0');

    fireEvent.change(q(UI.csvImport.builderName)!, { target: { value: 'クリーン銀行CSV' } });
    fireEvent.click(q(UI.csvImport.builderSave)!);
    // 確認ダイアログは出ず、そのまま取込フローへ進む。
    await waitFor(() => {
      expect(q(UI.csvImport.setupOpen)).not.toBeNull();
    });
    expect(q(UI.csvImport.builderSaveErrorsConfirm)).toBeNull();
    const ledger = await loadLedger();
    expect(ledger.importProfiles.find((p) => p.name === 'クリーン銀行CSV')).toBeDefined();
  });
});
