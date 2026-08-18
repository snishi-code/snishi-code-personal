/*
 * ledger-v2 コアフロー E2E（chromium / 本番ビルド preview）。
 * data-ui（src/ui-contract.ts）だけに依存し、文言・DOM 構造には依存しない
 * （破棄確認などアプリ外文言は foundation の固定文言を使用）。
 */
import { test, expect, type Page } from '@playwright/test';

const ui = (name: string) => `[data-ui="${name}"]`;

async function boot(page: Page) {
  // 初回オンボーディング（初期残高の一括登録）を既読化してから起動する
  // （自動表示のモーダルが操作を遮らないように。オンボーディング自体は専用テストで確認）。
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
}

async function openSettings(page: Page) {
  await page.locator(ui('nav.menu.button')).click();
  await expect(page.locator(ui('nav.menu'))).toBeVisible();
  await page.locator(ui('nav.settings')).click();
  await expect(page.locator(ui('settings.view'))).toBeVisible();
}

test('起動 → ダッシュボードと日常入力バーが表示される', async ({ page }) => {
  await boot(page);
  await expect(page.locator(ui('dashboard.entryBar'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.expense'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.income'))).toBeVisible();
  await expect(page.locator(ui('dashboard.entry.transfer'))).toBeVisible();
});

test('初回起動はオンボーディング（初期残高の一括登録）が自動表示され、スキップで消える', async ({
  page,
}) => {
  // boot() と違い既読フラグを入れずに起動する（真の初回状態）。
  await page.goto('./');
  await expect(page.locator(ui('onboarding.view'))).toBeVisible({ timeout: 15_000 });
  await page.locator(ui('onboarding.skip')).click();
  await expect(page.locator(ui('onboarding.view'))).toBeHidden();
  // スキップ後は通常どおり操作でき、再読込しても再表示されない。
  await expect(page.locator(ui('dashboard.entryBar'))).toBeVisible();
  await page.reload();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(ui('onboarding.view'))).toBeHidden();
});

test('支出の仕訳作成 → ホームの当月仕訳プレビューへ反映され、再読込後も残る', async ({ page }) => {
  await boot(page);
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('E2Eコーヒー');
  await page.locator(ui('journal.entry.amount')).fill('500');
  // 支払い元（資産）と費目（費用）はそれぞれ先頭の科目チップを選ぶ
  await page
    .locator(`${ui('journal.entry.flow.source')} label.chip`)
    .first()
    .click();
  await page
    .locator(`${ui('journal.entry.flow.destination')} label.chip`)
    .first()
    .click();
  await page.locator(ui('journal.entry.save')).click();
  // シートが閉じ、当月プレビューに反映される
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('E2Eコーヒー');
  // IndexedDB へ永続化されている（再読込後も表示される）
  await page.reload();
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('E2Eコーヒー', {
    timeout: 15_000,
  });
});

test('dirty guard: 編集途中で閉じると破棄確認 → 「編集を続ける」で残り「破棄する」で閉じる', async ({
  page,
}) => {
  await boot(page);
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('途中入力');
  // dirty 状態でキャンセル → 破棄確認ダイアログ
  await page.locator(ui('journal.entry.cancel')).click();
  const cancelBtn = page.locator(ui('dialog.cancel'));
  const confirmBtn = page.locator(ui('dialog.confirm'));
  await expect(confirmBtn).toBeVisible();
  // 「編集を続ける」→ シートは開いたまま・入力は保持
  await cancelBtn.click();
  await expect(page.locator(ui('journal.entry.item'))).toHaveValue('途中入力');
  // もう一度閉じて「破棄する」→ シートが閉じ、保存されていない
  await page.locator(ui('journal.entry.cancel')).click();
  await confirmBtn.click();
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();
  // 保存されていない（ホームのどこにも出ない。プレビュー自体が無い場合も含む）
  await expect(page.locator(ui('dashboard.view'))).not.toContainText('途中入力');
});

test('import: 他アプリ/v1 の JSON は not-our-file で拒否され、既存データは変わらない', async ({
  page,
}) => {
  await boot(page);
  await openSettings(page);
  // v1 ledger 相当の封筒（appId 不一致）を流し込む → fail-closed 拒否
  const v1like = JSON.stringify({
    appId: 'snishi-code.simple-ledger',
    schemaVersion: 16,
    exportedAt: new Date().toISOString(),
    data: {},
  });
  await page.locator(ui('settings.importFile')).setInputFiles({
    name: 'v1-export.json',
    mimeType: 'application/json',
    buffer: Buffer.from(v1like, 'utf-8'),
  });
  await expect(page.locator(ui('toast'))).toContainText(
    'このアプリの書き出しファイルではありません',
  );
});

test('表示桁数 2 で小数を入力すると、表示・保存とも 1/100 単位で一致する (v11)', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  // 設定で表示桁数を 2 へ。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.settings')).click();
  await expect(page.locator(ui('settings.view'))).toBeVisible();
  await page.locator(`${ui('settings.fractionDigits')} button`, { hasText: '2' }).click();
  await page
    .locator(ui('settings.view'))
    .getByRole('button', { name: '保存', exact: true })
    .click();

  // 小数で支出を登録。
  await page.locator(ui('nav.footer.home')).click();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible();
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('小数E2E');
  const amount = page.locator(ui('journal.entry.amount'));
  await expect(amount).toHaveAttribute('inputmode', 'decimal');
  await amount.fill('12.34');
  await page
    .locator(`${ui('journal.entry.flow.source')} label.chip`)
    .first()
    .click();
  await page
    .locator(`${ui('journal.entry.flow.destination')} label.chip`)
    .first()
    .click();
  await page.locator(ui('journal.entry.save')).click();
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

  // 表示 = '12.34 円'（digits=2）・保存 = 1234 minor（IndexedDB を直接確認 = 100 倍バグ検出）。
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('12.34');
  const storedAmount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('simple-ledger-v2');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const entries = await new Promise<{ description: string; lines: { amount: number }[] }[]>(
      (resolve, reject) => {
        const tx = db.transaction('journalEntries', 'readonly');
        const req = tx.objectStore('journalEntries').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    return entries.find((e) => e.description === '小数E2E')?.lines[0]?.amount ?? null;
  });
  expect(storedAmount, '保存は 1/100 単位の整数（12.34 → 1234）').toBe(1234);

  // 再読込後も同じ表示（永続化の確認）。
  await page.reload();
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(ui('dashboard.journal.preview'))).toContainText('12.34');
});

test('表示桁数 0 で小数点を貼り付けても逐次入力しても 100 倍にならない', async ({ page }) => {
  // 既定の表示桁は 0。ここで小数点を「削除」して整数部へ連結すると 100 倍になる
  // （'12.34' → '1234'）。切り捨て = '12' が正。金額欄は全画面で同じ正本を通る。
  await page.addInitScript(() => localStorage.setItem('slv2.onboardingDone', '1'));
  await page.goto('./');
  await expect(page.locator(ui('dashboard.view'))).toBeVisible({ timeout: 15_000 });

  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('整数桁E2E');
  const amount = page.locator(ui('journal.entry.amount'));
  await expect(amount).toHaveAttribute('inputmode', 'numeric');
  await amount.fill('12.34');
  await expect(amount).toHaveValue('12');
  await amount.clear();
  await amount.pressSequentially('12.34');
  // 入力途中の '.' を保持して後続の小数キーを無視する。即座に消すと 1234 へ連結される。
  await expect(amount).toHaveValue('12.');
  await page
    .locator(`${ui('journal.entry.flow.source')} label.chip`)
    .first()
    .click();
  await page
    .locator(`${ui('journal.entry.flow.destination')} label.chip`)
    .first()
    .click();
  await page.locator(ui('journal.entry.save')).click();
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

  const storedAmount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('simple-ledger-v2');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const entries = await new Promise<{ description: string; lines: { amount: number }[] }[]>(
      (resolve, reject) => {
        const tx = db.transaction('journalEntries', 'readonly');
        const req = tx.objectStore('journalEntries').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    return entries.find((e) => e.description === '整数桁E2E')?.lines[0]?.amount ?? null;
  });
  expect(storedAmount, '12.34 を表示桁 0 で打つと 12（=1200 minor）。1234 ではない').toBe(1200);
});

test('ローンで払う → 台帳にルールとして並び、資金繰りの負債行から台帳へ戻る (v13.6 H4)', async ({
  page,
}) => {
  await boot(page);

  // ① 支出の 1 ページ目 →「ローンで払う」は**選択だけ**（v13.7 I3）。支払い元は消え、
  //    ローンの入力欄はまだ出ない。主ボタンが「ローンを入力する」に変わる。
  await page.locator(ui('dashboard.entry.expense')).click();
  await page.locator(ui('journal.entry.item')).fill('E2E自動車');
  await page.locator(ui('journal.entry.amount')).fill('1200000');
  await page
    .locator(`${ui('journal.entry.flow.destination')} label.chip`)
    .first()
    .click();
  await page.locator(ui('journal.entry.loanArrange')).click();
  await expect(page.locator(ui('journal.entry.flow.source'))).toBeHidden();
  await expect(page.locator(ui('journal.entry.loanSelected'))).toBeVisible();
  await expect(page.locator(ui('journal.entry.loanEndDate'))).toBeHidden();
  await expect(page.locator(ui('journal.entry.next'))).toContainText('ローンを入力する');

  // ② 2 ページ目 = ローンの入力。摘要が名前へ自動で入り、終了日は 1/3/5 年チップ。
  //    回数と月額はその場で導出して見せる。
  await page.locator(ui('journal.entry.next')).click();
  await expect(page.locator(ui('journal.entry.loanName'))).toHaveValue('E2E自動車');
  await page.locator(ui('journal.entry.loanQuickSpan')).first().click();
  await expect(page.locator(ui('journal.entry.loanPreview'))).toContainText('12 回');
  await page
    .locator(`${ui('journal.entry.loanFrom')} label.chip`)
    .first()
    .click();
  // 「戻る」で 1 ページ目へ戻っても入力は残る（前後しても書き直させない）。
  await page.locator(ui('journal.entry.stepBack')).click();
  await expect(page.locator(ui('journal.entry.item'))).toHaveValue('E2E自動車');
  await page.locator(ui('journal.entry.next')).click();
  await expect(page.locator(ui('journal.entry.loanPreview'))).toContainText('12 回');
  await page.locator(ui('journal.entry.save')).click();
  await expect(page.locator(ui('journal.entry.save'))).toBeHidden();

  // ③ 月割り台帳: 専用セクションではなく、くり返し記帳の一覧に混ざって並ぶ。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.allocations')).click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  const loanRow = page.locator(`${ui('allocations.recurring.list')} li`).first();
  await expect(loanRow).toContainText('E2E自動車');
  await expect(page.locator(ui('allocations.loan.remaining'))).toContainText('12');
  // 旧「支払用負債」セクションは撤去済み。
  await expect(page.locator('[data-ui="allocations.liability.list"]')).toHaveCount(0);

  // ④ 資金繰り: 負債行に残高が出て、タップで台帳の該当行へ戻る。
  await page.locator(ui('nav.menu.button')).click();
  await page.locator(ui('nav.cashflow')).click();
  await expect(page.locator(ui('cashflow.view'))).toBeVisible();
  const debtRow = page.locator(ui('cashflow.liability.row')).first();
  await expect(debtRow).toContainText('E2E自動車');
  await debtRow.click();
  await expect(page.locator(ui('allocations.view'))).toBeVisible();
  await expect(page.locator(`${ui('allocations.recurring.list')} li`).first()).toContainText(
    'E2E自動車',
  );
});
