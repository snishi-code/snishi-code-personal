/*
 * CSV 取込画面（取込フロー §4・binding セットアップ §1-1b・決定済み一覧 §4-6）の UI テスト。
 *  - ハッピーパス: 合成 CSV → profile 選択 → binding セットアップ → 件数会計 → 一括適用 →
 *    仕訳と decision が残る → 同じファイルの再読込で全行スキップ（決定的スキップ）
 *  - 個別: 類似候補からのリンク / 無視 → 再取込で出ない → 一覧から解除 → 再び出る
 *  - エラー行のある CSV: 件数と明細・error 行はレビューに出ない（§4-2 の保存則）
 *  - binding: 借貸同一の拒否（UI 入口）・セットアップ未完では取込に進めない（gate）
 *  - ui-contract: data-ui キーの存在と、タップ要素が 44px 系クラスを持つこと
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@snishi/foundation/ui/toast';
import { patchDialogIfNeeded } from '@snishi/foundation/ui/test-utils';
import { CsvImport } from '../src/ui/screens/CsvImport';
import { LedgerProvider } from '../src/state/store';
import { _resetOverlaysForTests } from '../src/ui/overlays';
import {
  loadLedger,
  upsertEntry,
  upsertImportProfile,
  upsertProfileBinding,
} from '../src/data/repository';
import { putRecord, STORE } from '../src/data/db';
import { buildSimpleEntry } from '../src/domain/entry';
import { externalRowKey } from '../src/domain/importIdentity';
import { PAYPAY_PROFILE_ID } from '../src/domain/importProfilePresets';
import { UI } from '../src/ui-contract';
import type { ImportProfileDsl } from '../src/domain/importDsl';
import type { Account, Ledger } from '../src/domain/types';
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

function renderScreen(onOpenEntry: (entryId: string) => void = () => undefined) {
  return render(
    <ToastProvider>
      <LedgerProvider>
        <CsvImport onOpenEntry={onOpenEntry} />
      </LedgerProvider>
    </ToastProvider>,
  );
}

function account(ledger: Ledger, name: string): Account {
  const found = ledger.accounts.find((a) => a.name === name);
  if (!found) throw new Error(`account not found: ${name}`);
  return found;
}

/** `.kv` 行（ラベル + 値）から値テキストを読む。 */
function kvValue(scope: Element, label: string): string | undefined {
  for (const row of scope.querySelectorAll('.kv')) {
    const spans = row.querySelectorAll('span');
    if (spans[0]?.textContent === label) return spans[1]?.textContent ?? undefined;
  }
  return undefined;
}

const CSV_HEADER = '取引日,出金金額（円）,入金金額（円）,取引内容,取引先,取引番号';

/** 行種 3 種（支払い / 獲得 / チャージ）+ quote 込みカンマ金額の合成 CSV。 */
const HAPPY_CSV = [
  CSV_HEADER,
  '2026/08/01 10:00:00,"1,000",-,支払い,コンビニ,T001',
  '2026/08/02 09:00:00,-,500,ポイント、残高の獲得,PayPay,T002',
  '2026/08/03 12:00:00,-,"3,000",チャージ,PayPay,T003',
].join('\r\n');

const SINGLE_PAYMENT_CSV = [CSV_HEADER, '2026/08/01 10:00:00,1000,-,支払い,コンビニ,L001'].join(
  '\n',
);

/** blocking error 3 種（未知 kind・出金/入金 both・金額パース失敗）+ 正常 1 行。 */
const ERROR_CSV = [
  CSV_HEADER,
  '2026/08/01 10:00:00,100,-,支払い,店,E001',
  '2026/08/02 10:00:00,200,-,謎の行種,店,E002',
  '2026/08/03 10:00:00,300,400,支払い,店,E003',
  '2026/08/04 10:00:00,abc,-,支払い,店,E004',
].join('\n');

function csvFile(text: string, name = 'transactions.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

function selectFile(file: File): void {
  const input = q(UI.csvImport.fileInput);
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [file] } });
}

function selectProfile(profileId: string = PAYPAY_PROFILE_ID): void {
  const select = q(UI.csvImport.profile);
  expect(select).not.toBeNull();
  fireEvent.change(select!, { target: { value: profileId } });
}

/** binding の不変な取込元 ID（行キーの名前空間・表示名「PayPay本体」とは別・監査 P1-3）。 */
const UI_SOURCE_ID = 'source-ui-paypay';

/** binding をデータ層で先に用意する（セットアップシート UI はハッピーパス側で検証）。 */
async function seedBinding(): Promise<void> {
  const ledger = await loadLedger();
  const ts = new Date().toISOString();
  const income = account(ledger, 'その他収入');
  await upsertProfileBinding({
    id: 'binding-ui-test',
    profileId: PAYPAY_PROFILE_ID,
    sourceId: UI_SOURCE_ID,
    sourceIdentity: 'PayPay本体',
    ownAccountId: account(ledger, 'チャージ残高').id,
    kindDestinations: {
      'ポイント、残高の獲得': income.id,
      'ポイント、残高の取消': income.id,
    },
    chargeSourceAccountId: account(ledger, '預金').id,
    createdAt: ts,
    updatedAt: ts,
  });
}

/* ── fingerprint キー（externalId 無し profile）用のヘルパー ── */

const FP_PROFILE_ID = 'fp-profile-ui';
const FP_SOURCE = '指紋口座';

/** externalId を定義しない最小 DSL（行キーは fingerprint + occurrence になる）。 */
const FP_DSL: ImportProfileDsl = {
  dslVersion: 1,
  fileFormat: { encoding: 'utf-8', delimiter: ',', headerRowIndex: 0 },
  columns: {
    date: { column: '日付', format: 'YYYY-MM-DD' },
    amount: { mode: 'signed', column: '金額', positiveDirection: 'inflow' },
    description: { columns: ['内容'] },
  },
  kindRules: [{ when: { op: 'contains', column: '内容', value: '' }, kind: '支払い' }],
};

const FP_HEADER = '日付,金額,内容';
/** 同一生行（= 同一 fingerprint）を n 件並べた CSV。 */
function fpCsv(sameRowCount: number): string {
  return [FP_HEADER, ...Array<string>(sameRowCount).fill('2026-08-01,-1000,コンビニ')].join('\n');
}

async function seedFpProfileAndBinding(): Promise<void> {
  const ledger = await loadLedger();
  const ts = new Date().toISOString();
  await upsertImportProfile({
    id: FP_PROFILE_ID,
    name: '指紋テスト',
    dsl: FP_DSL,
    createdAt: ts,
    updatedAt: ts,
  });
  await upsertProfileBinding({
    id: 'binding-fp-ui-test',
    profileId: FP_PROFILE_ID,
    sourceId: 'source-ui-fp',
    sourceIdentity: FP_SOURCE,
    ownAccountId: account(ledger, 'チャージ残高').id,
    kindDestinations: { 支払い: account(ledger, '変動費').id },
    createdAt: ts,
    updatedAt: ts,
  });
}

/** kindGroup カードを行種名で引く。 */
function kindGroupOf(kind: string): HTMLElement {
  const group = qa(UI.csvImport.kindGroup).find((el) => el.textContent?.includes(kind));
  expect(group).toBeDefined();
  return group!;
}

async function waitForProfileSelect(): Promise<void> {
  await waitFor(() => {
    expect(q(UI.csvImport.profile)).not.toBeNull();
  });
}

describe('CSV 取込 — ハッピーパス（§4）', () => {
  it('セットアップ → 件数会計 → 一括/個別適用 → 完了 → 再読込で全行スキップ', async () => {
    const screen = renderScreen();
    await waitForProfileSelect();

    // profile とファイルを選んでも binding 未設定なら取込に進めない（gate・§1-1b）。
    selectProfile();
    selectFile(csvFile(HAPPY_CSV));
    await waitFor(() => {
      expect(q(UI.csvImport.setupOpen)).not.toBeNull();
    });
    expect(q(UI.csvImport.counts)).toBeNull();

    // セットアップシート: 取込元の命名・自口座・獲得/取消の計上先（サジェスト）・チャージ源泉。
    fireEvent.click(q(UI.csvImport.setupOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.setup)).not.toBeNull();
    });
    fireEvent.change(q(UI.csvImport.setupIdentity)!, { target: { value: 'PayPay本体' } });
    fireEvent.click(within(q(UI.csvImport.setupOwn)!).getByRole('radio', { name: 'チャージ残高' }));
    // サジェスト（その他収入）は表示されるだけで自動確定しない → タップで確定。
    const save = q(UI.csvImport.setupSave) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(q(UI.csvImport.setupIncomeSuggest)!);
    fireEvent.click(within(q(UI.csvImport.setupCharge)!).getByRole('radio', { name: '預金' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    // 件数会計（§4-2 の保存則: 総行数 = 取込対象 + スキップ + エラー）。
    await waitFor(() => {
      expect(q(UI.csvImport.counts)).not.toBeNull();
    });
    const counts = q(UI.csvImport.counts)!;
    expect(kvValue(counts, '総行数')).toBe('3');
    expect(kvValue(counts, '取込対象')).toBe('3');
    expect(kvValue(counts, 'スキップ')).toBe('0');
    expect(kvValue(counts, 'エラー')).toBe('0');

    // レビュー: 3 行種。既定計上先のある獲得・チャージにだけ一括適用が出る。
    expect(qa(UI.csvImport.row)).toHaveLength(3);
    expect(qa(UI.csvImport.kindBulk)).toHaveLength(2);

    // 支払い（最古の行）は行単位選択: 行タップ → シートで計上先（変動費）を選んで適用。
    // 日付昇順で適用する（暗黙開始日の科目は最初の参照で開始点が固定されるため、
    // 新しい日付から適用すると後から古い行が期間外参照で拒否される既存仕様）。
    fireEvent.click(within(kindGroupOf('支払い')).getByText('支払い コンビニ'));
    await waitFor(() => {
      expect(q(UI.csvImport.applySheet)).not.toBeNull();
    });
    fireEvent.click(within(q(UI.csvImport.applyCounter)!).getByRole('radio', { name: '変動費' }));
    fireEvent.click(q(UI.csvImport.applySave)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(2);
    });

    // 獲得の一括適用: 確認に対象件数と仕訳形（借方 自口座 / 貸方 計上先）が出る。
    fireEvent.click(
      within(kindGroupOf('ポイント、残高の獲得')).getByRole('button', { name: 'まとめて適用' }),
    );
    await waitFor(() => {
      expect(q(UI.csvImport.bulkConfirm)).not.toBeNull();
    });
    const bulkBody = q(UI.csvImport.bulkConfirm)!.textContent ?? '';
    expect(bulkBody).toContain('借方 チャージ残高 / 貸方 その他収入 — 1 件');
    fireEvent.click(
      within(q(UI.csvImport.bulkConfirm)!).getByRole('button', { name: 'まとめて適用' }),
    );
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });

    // チャージは binding のチャージ源泉が既定 → ワンタップ適用。全行決定で「取込完了」。
    fireEvent.click(within(kindGroupOf('チャージ')).getByLabelText(/^適用: /));
    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });

    // データ検証: 仕訳 3 件（由来メタ付き）+ decision 3 件（registered）。
    const ledger = await loadLedger();
    const imported = ledger.journalEntries.filter((e) => e.metadata?.importSource !== undefined);
    expect(imported).toHaveLength(3);
    const gain = imported.find((e) => e.description.includes('獲得'))!;
    const own = account(ledger, 'チャージ残高');
    const income = account(ledger, 'その他収入');
    expect(gain.lines).toEqual([
      { accountId: own.id, side: 'debit', amount: 500 },
      { accountId: income.id, side: 'credit', amount: 500 },
    ]);
    expect(ledger.importDecisions).toHaveLength(3);
    expect(ledger.importDecisions.every((d) => d.status === 'registered')).toBe(true);

    // 同じファイルの再読込（画面を開き直す = 別セッションの再取込と同型）→
    // 決定的スキップで全行除外・レビュー 0 件のまま「取込完了」。
    screen.unmount();
    _resetOverlaysForTests();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(HAPPY_CSV));
    await waitFor(() => {
      expect(q(UI.csvImport.counts)).not.toBeNull();
    });
    expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 3 件を除外し');
    expect(qa(UI.csvImport.row)).toHaveLength(0);
    expect(q(UI.csvImport.complete)).not.toBeNull();
    // ファイル記録（fileHash → 進み具合）も表示される。
    expect(q(UI.csvImport.fileRecord)).not.toBeNull();
    const after = await loadLedger();
    expect(after.journalEntries.filter((e) => e.metadata?.importSource !== undefined)).toHaveLength(
      3,
    );
  });
});

describe('CSV 取込 — 個別行の決定（リンク・無視・解除）', () => {
  it('類似候補から既存仕訳へリンクできる（新規仕訳は作らない）', async () => {
    const ledger = await loadLedger();
    await seedBinding();
    // 自口座（チャージ残高）の貸方 1,000 円・同日 = 類似候補の条件（§5-2 層2）。
    const existing = buildSimpleEntry({
      date: '2026-08-01',
      description: '手入力の支払い',
      debitAccountId: account(ledger, '変動費').id,
      creditAccountId: account(ledger, 'チャージ残高').id,
      amount: 1000,
    });
    await upsertEntry(existing);

    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });

    fireEvent.click(qa(UI.csvImport.rowLink)[0]!);
    await waitFor(() => {
      expect(q(UI.csvImport.linkSheet)).not.toBeNull();
    });
    // 類似候補が先頭に提示される（自動処理はしない）。
    const candidates = qa(UI.csvImport.linkCandidate);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.textContent).toContain('手入力の支払い');
    fireEvent.click(candidates[0]!);

    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });
    const after = await loadLedger();
    // 仕訳は増えず、linked decision が既存仕訳を指す。
    expect(after.journalEntries).toHaveLength(ledger.journalEntries.length + 1); // 手入力分のみ
    expect(after.importDecisions).toHaveLength(1);
    expect(after.importDecisions[0]!.status).toBe('linked');
    expect(after.importDecisions[0]!.entryId).toBe(existing.id);
  });

  it('無視 → 再取込で出ない → 一覧から解除 → 再びレビューに出る', async () => {
    await loadLedger();
    await seedBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });

    fireEvent.click(qa(UI.csvImport.rowIgnore)[0]!);
    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });

    // 再取込（同じファイル）→ 無視済みは決定的スキップ＝レビューに出ない。
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 1 件を除外し');
    });
    expect(qa(UI.csvImport.row)).toHaveLength(0);

    // 決定済み一覧（§4-6）: 無視で絞り込み → 解除（確認 1 つ）。
    fireEvent.click(q(UI.csvImport.tabDecisions)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.decisionRow).length).toBeGreaterThan(0);
    });
    fireEvent.click(q(UI.csvImport.statusIgnored)!);
    const row = qa(UI.csvImport.decisionRow)[0]!;
    expect(row.textContent).toContain('無視');
    expect(row.textContent).toContain('L001'); // rowKey の可読部分（取引番号 + 取引内容）
    fireEvent.click(within(row).getByLabelText(/^解除: /));
    await waitFor(() => {
      expect(q(UI.csvImport.removeConfirm)).not.toBeNull();
    });
    fireEvent.click(within(q(UI.csvImport.removeConfirm)!).getByRole('button', { name: '解除' }));
    await waitFor(() => {
      expect(qa(UI.csvImport.decisionRow)).toHaveLength(0);
    });
    const after = await loadLedger();
    expect(after.importDecisions).toHaveLength(0);

    // 取込タブへ戻ると同じ行が再びレビューに出る（解除 = 未解決へ戻す・冪等）。
    fireEvent.click(q(UI.csvImport.tabFlow)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });
  });

  it('取込元の表示名を変更しても決定は生きている（sourceId 名前空間・監査 P1-3）', async () => {
    await loadLedger();
    await seedBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });

    // 1 行を無視で決定してから、取込元の表示名を編集する（編集入力は disabled でない）。
    fireEvent.click(qa(UI.csvImport.rowIgnore)[0]!);
    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });
    fireEvent.click(q(UI.csvImport.sourceEdit)!);
    await waitFor(() => {
      expect(q(UI.csvImport.setup)).not.toBeNull();
    });
    const identityInput = q(UI.csvImport.setupIdentity) as HTMLInputElement;
    expect(identityInput.disabled).toBe(false);
    fireEvent.change(identityInput, { target: { value: 'PayPay改名後' } });
    fireEvent.click(q(UI.csvImport.setupSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.setup)).toBeNull();
    });

    // 改名後もレビューは決定済みを除外し続ける（rowKey の名前空間は sourceId のため無傷）。
    await waitFor(() => {
      expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 1 件を除外し');
    });
    expect(qa(UI.csvImport.row)).toHaveLength(0);
    const ledger = await loadLedger();
    expect(ledger.importDecisions).toHaveLength(1);
    expect(ledger.profileBindings[0]!.sourceIdentity).toBe('PayPay改名後');
    expect(ledger.profileBindings[0]!.sourceId).toBe(UI_SOURCE_ID);

    // 決定済み一覧の取込元表示も現在の表示名で出る。
    fireEvent.click(q(UI.csvImport.tabDecisions)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.decisionRow).length).toBeGreaterThan(0);
    });
    expect(qa(UI.csvImport.decisionRow)[0]!.textContent).toContain('PayPay改名後');
  });
});

describe('CSV 取込 — エラー行の件数会計（§4-2 の保存則）', () => {
  it('blocking error は件数と明細に出て、レビュー（適用対象）には出ない', async () => {
    await loadLedger();
    await seedBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(ERROR_CSV));

    await waitFor(() => {
      expect(q(UI.csvImport.counts)).not.toBeNull();
    });
    const counts = q(UI.csvImport.counts)!;
    // 保存則: 総行数 4 = 取込対象 1 + スキップ 0 + エラー 3。
    expect(kvValue(counts, '総行数')).toBe('4');
    expect(kvValue(counts, '取込対象')).toBe('1');
    expect(kvValue(counts, 'スキップ')).toBe('0');
    expect(kvValue(counts, 'エラー')).toBe('3');

    // 明細を開くと理由コード別の文言と行番号が見える。
    fireEvent.click(q(UI.csvImport.errorToggle)!);
    const list = q(UI.csvImport.errorList)!;
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(list.textContent).toContain('どの行種にも当てはまりません');
    expect(list.textContent).toContain('出金と入金の両方に金額があります');
    expect(list.textContent).toContain('金額を読み取れません');
    expect(list.textContent).toContain('3 行目');

    // error 行はレビューに出ない（正常 1 行のみ）。
    expect(qa(UI.csvImport.row)).toHaveLength(1);
  });
});

describe('CSV 取込 — binding セットアップの拒否（§1-1b）', () => {
  it('同一科目の借貸両側（自口座 = チャージ源泉）は保存できない', async () => {
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(q(UI.csvImport.setupOpen)).not.toBeNull();
    });
    fireEvent.click(q(UI.csvImport.setupOpen)!);
    await waitFor(() => {
      expect(q(UI.csvImport.setup)).not.toBeNull();
    });

    fireEvent.change(q(UI.csvImport.setupIdentity)!, { target: { value: 'PayPay本体' } });
    fireEvent.click(within(q(UI.csvImport.setupOwn)!).getByRole('radio', { name: 'チャージ残高' }));
    fireEvent.click(q(UI.csvImport.setupIncomeSuggest)!);
    // チャージ源泉に自口座と同じ科目 → エラー表示 + 保存不可（fail-closed）。
    fireEvent.click(
      within(q(UI.csvImport.setupCharge)!).getByRole('radio', { name: 'チャージ残高' }),
    );
    expect(q(UI.csvImport.setupCharge)!.textContent).toContain('自口座と同じ科目は選べません');
    expect((q(UI.csvImport.setupSave) as HTMLButtonElement).disabled).toBe(true);

    // 別の科目へ直せば保存でき、レビューまで進む。
    fireEvent.click(within(q(UI.csvImport.setupCharge)!).getByRole('radio', { name: '預金' }));
    expect((q(UI.csvImport.setupSave) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(q(UI.csvImport.setupSave)!);
    await waitFor(() => {
      expect(q(UI.csvImport.counts)).not.toBeNull();
    });
    const ledger = await loadLedger();
    expect(ledger.profileBindings).toHaveLength(1);
    expect(ledger.profileBindings[0]!.chargeSourceAccountId).not.toBe(
      ledger.profileBindings[0]!.ownAccountId,
    );
  });
});

describe('CSV 取込 — fingerprint 行の部分適用（P1 回帰: 決定の誤削除禁止）', () => {
  it('同一生行 3 件の 1 件だけ適用 → 決定は無傷・残りは普通の未解決・再適用で二重仕訳にならない', async () => {
    await loadLedger();
    await seedFpProfileAndBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile(FP_PROFILE_ID);
    selectFile(csvFile(fpCsv(3), 'fp3.csv'));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(3);
    });

    // occurrence 1 だけワンタップ適用 → 旧仕様はここで count-mismatch 扱いになり
    // 生きた決定を黙って削除していた（本テストの主目的）。
    fireEvent.click(qa(UI.csvImport.rowApply)[0]!);
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(2);
    });
    let ledger = await loadLedger();
    expect(ledger.importDecisions).toHaveLength(1);
    expect(
      ledger.journalEntries.filter((e) => e.metadata?.importSource !== undefined),
    ).toHaveLength(1);
    // 残り 2 行は警告バッジ無しの普通の未解決（mismatch 扱いしない）。
    expect(document.body.textContent).not.toContain('要再確認');
    expect(q(UI.csvImport.occurrenceShortage)).toBeNull();

    // 同じファイルを読み直しても決定は消えない・決定済み 1 件を除外して残り 2 件が出る。
    // （旧レビューと新レビューは同一表示になるため、いったん消えてから再表示されるのを待つ）
    selectFile(csvFile(fpCsv(3), 'fp3-again.csv'));
    await waitFor(() => {
      expect(q(UI.csvImport.counts)).toBeNull();
    });
    await waitFor(() => {
      expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 1 件を除外し');
    });
    expect(qa(UI.csvImport.row)).toHaveLength(2);
    ledger = await loadLedger();
    expect(ledger.importDecisions).toHaveLength(1);

    // 残り 2 件を適用しきる → 3 決定・3 仕訳。
    fireEvent.click(qa(UI.csvImport.rowApply)[0]!);
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });
    fireEvent.click(qa(UI.csvImport.rowApply)[0]!);
    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });

    // 再読込 → 全行決定的スキップ・仕訳は 3 件のまま（二重仕訳なし）。
    selectFile(csvFile(fpCsv(3), 'fp3-final.csv'));
    await waitFor(() => {
      expect(q(UI.csvImport.counts)).toBeNull();
    });
    await waitFor(() => {
      expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 3 件を除外し');
    });
    expect(qa(UI.csvImport.row)).toHaveLength(0);
    expect(q(UI.csvImport.complete)).not.toBeNull();
    ledger = await loadLedger();
    expect(ledger.importDecisions).toHaveLength(3);
    expect(
      ledger.journalEntries.filter((e) => e.metadata?.importSource !== undefined),
    ).toHaveLength(3);
  });
});

describe('CSV 取込 — 出現数が過去より少ないファイル（n < k は警告バナーのみ）', () => {
  it('過去 2 件決定済み・今回 1 行のファイル → 警告を情報提示し決定は無傷', async () => {
    await loadLedger();
    await seedFpProfileAndBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile(FP_PROFILE_ID);

    // 同一生行 2 件のファイルを全行適用（k = 2）。
    selectFile(csvFile(fpCsv(2), 'fp2.csv'));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(2);
    });
    fireEvent.click(qa(UI.csvImport.rowApply)[0]!);
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });
    fireEvent.click(qa(UI.csvImport.rowApply)[0]!);
    await waitFor(() => {
      expect(q(UI.csvImport.complete)).not.toBeNull();
    });

    // 同一生行が 1 件しか無いファイル（n = 1 < k = 2）→ 警告バナー + 決定どおり除外。
    selectFile(csvFile(fpCsv(1), 'fp1.csv'));
    await waitFor(() => {
      expect(q(UI.csvImport.occurrenceShortage)).not.toBeNull();
    });
    expect(q(UI.csvImport.occurrenceShortage)!.textContent).toContain(
      '過去の取込時より少ないファイル',
    );
    expect(q(UI.csvImport.counts)!.textContent).toContain('決定済み 1 件を除外し');
    expect(qa(UI.csvImport.row)).toHaveLength(0);
    // 決定は 1 件も消えていない（旧仕様はここで 2 件とも削除していた）。
    const ledger = await loadLedger();
    expect(ledger.importDecisions).toHaveLength(2);
  });
});

describe('CSV 取込 — dangling 決定（自動削除せず明示解除だけが消す）', () => {
  it('参照先仕訳の無い決定 → 要再確認 + 解除ボタンのみ・解除後に普通の未解決へ戻る', async () => {
    await loadLedger();
    await seedBinding();
    // 参照先仕訳が実在しない registered 決定を直接注入する（破損状態の再現。
    // 通常経路では仕訳削除 cascade が決定を同時解除するため、ここでは DB へ直書きする）。
    const ts = new Date().toISOString();
    await putRecord(STORE.importDecisions, {
      key: externalRowKey(UI_SOURCE_ID, ['L001', '支払い']),
      status: 'registered',
      entryId: 'ghost-missing-entry',
      decidedAt: ts,
      provenance: {
        profileId: PAYPAY_PROFILE_ID,
        profileDigest: 'digest-x',
        fileHash: 'file-x',
        sourceId: UI_SOURCE_ID,
        identityVersion: 1,
      },
    });

    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(SINGLE_PAYMENT_CSV));
    await waitFor(() => {
      expect(qa(UI.csvImport.row)).toHaveLength(1);
    });

    // レビューには出るが適用不可: バッジ + 説明 + 解除ボタンだけ（適用/リンク/無視は無い）。
    const row = qa(UI.csvImport.row)[0]!;
    expect(row.textContent).toContain('要再確認');
    expect(row.textContent).toContain('仕訳が見つかりません');
    expect(qa(UI.csvImport.rowApply)).toHaveLength(0);
    expect(qa(UI.csvImport.rowLink)).toHaveLength(0);
    expect(qa(UI.csvImport.rowIgnore)).toHaveLength(0);
    expect(q(UI.csvImport.rowRelease)).not.toBeNull();
    // 一括適用ボタンも出ない（dangling は一括の対象外）。
    expect(qa(UI.csvImport.kindBulk)).toHaveLength(0);
    // レビューを組み立てただけでは決定は消えない（読み取り専用）。
    expect((await loadLedger()).importDecisions).toHaveLength(1);

    // 明示解除 → store 経由で削除され、React 側の決定済み一覧も空になり、行は普通の未解決へ
    // （支払い行に既定計上先は無いので、リンク・無視の操作が戻ることを確認する）。
    fireEvent.click(q(UI.csvImport.rowRelease)!);
    await waitFor(() => {
      expect(qa(UI.csvImport.rowIgnore)).toHaveLength(1);
    });
    expect(qa(UI.csvImport.rowLink)).toHaveLength(1);
    expect(q(UI.csvImport.rowRelease)).toBeNull();
    expect(document.body.textContent).not.toContain('要再確認');
    expect((await loadLedger()).importDecisions).toHaveLength(0);
    fireEvent.click(q(UI.csvImport.tabDecisions)!);
    await waitFor(() => {
      expect(q(UI.csvImport.decisionsList)).toBeNull();
    });
  });
});

describe('CSV 取込 — externalId のファイル内衝突（評価段階の error 行）', () => {
  it('同一識別子の行は全行 error として件数会計に出て、レビューに出ない', async () => {
    await loadLedger();
    await seedBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    // T001 が 2 行で衝突（externalId = [取引番号, 取引内容]）・T900 は一意。
    const dupCsv = [
      CSV_HEADER,
      '2026/08/01 10:00:00,100,-,支払い,店A,T001',
      '2026/08/02 10:00:00,200,-,支払い,店B,T001',
      '2026/08/03 10:00:00,300,-,支払い,店C,T900',
    ].join('\n');
    selectFile(csvFile(dupCsv, 'dup.csv'));

    await waitFor(() => {
      expect(q(UI.csvImport.counts)).not.toBeNull();
    });
    const counts = q(UI.csvImport.counts)!;
    // 保存則: 総行数 3 = 取込対象 1 + スキップ 0 + エラー 2。
    expect(kvValue(counts, '総行数')).toBe('3');
    expect(kvValue(counts, '取込対象')).toBe('1');
    expect(kvValue(counts, 'スキップ')).toBe('0');
    expect(kvValue(counts, 'エラー')).toBe('2');
    fireEvent.click(q(UI.csvImport.errorToggle)!);
    expect(q(UI.csvImport.errorList)!.textContent).toContain(
      '同じ識別子の行がファイル内に複数あります',
    );
    // レビューは一意な行だけ・決定は 1 件も作られていない。
    expect(qa(UI.csvImport.row)).toHaveLength(1);
    expect((await loadLedger()).importDecisions).toHaveLength(0);
  });
});

describe('CSV 取込 — ui-contract（data-ui とタップ要素のクラス）', () => {
  it('主要 data-ui が存在し、全ボタンが 44px 系クラス（btn/icon-btn/…）を持つ', async () => {
    await loadLedger();
    await seedBinding();
    renderScreen();
    await waitForProfileSelect();
    selectProfile();
    selectFile(csvFile(HAPPY_CSV));
    await waitFor(() => {
      expect(qa(UI.csvImport.row).length).toBeGreaterThan(0);
    });

    // 契約キーの存在（文言変更で壊れない安定名）。
    for (const key of [
      UI.csvImport.view,
      UI.csvImport.tabFlow,
      UI.csvImport.tabDecisions,
      UI.csvImport.filePick,
      UI.csvImport.fileInput,
      UI.csvImport.profile,
      UI.csvImport.source,
      UI.csvImport.sourceEdit,
      UI.csvImport.sourceAdd,
      UI.csvImport.counts,
      UI.csvImport.reviewList,
      UI.csvImport.kindGroup,
      UI.csvImport.kindBulk,
      UI.csvImport.row,
      UI.csvImport.rowApply,
      UI.csvImport.rowLink,
      UI.csvImport.rowIgnore,
    ]) {
      expect(q(key), key).not.toBeNull();
    }

    // タップ要素は既存のサイズ規約クラスに乗る（CSS 側で min-height: var(--tap) = 44px）。
    // list__main は行全体（.list__item の min-height）でタップ領域を確保する既存流儀。
    const allowed = ['btn', 'icon-btn', 'segmented__btn', 'list__main', 'list__row-btn'];
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const classes = [...button.classList];
      expect(
        allowed.some((cls) => classes.includes(cls)),
        `button without tap-size class: ${button.outerHTML.slice(0, 120)}`,
      ).toBe(true);
    }
  });
});
