import { expect, test, type Locator, type Page } from '@playwright/test';

const SUBJECT_NAME = 'E2E巡回対象';

async function openFreshApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'テンプレメモ' })).toBeVisible();
}

async function addSubject(page: Page, name = SUBJECT_NAME) {
  await page.getByRole('button', { name: '＋対象を追加' }).click();

  const dialog = page.getByRole('dialog', { name: '＋対象を追加' });
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByLabel('管理ID').fill('E2E-001');
  await dialog.getByLabel('位置').fill('E2E区画');
  await dialog.getByRole('button', { name: '追加', exact: true }).click();

  await expect(page.getByRole('button', { name })).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByText('設定', { exact: true }).first()).toBeVisible();
}

async function expectRenderedQr(canvas: Locator) {
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const qr = element as HTMLCanvasElement;
        const context = qr.getContext('2d');
        if (!context || qr.width <= 0 || qr.width !== qr.height) return false;
        return context.getImageData(0, 0, qr.width, qr.height).data.some((value) => value !== 0);
      }),
    )
    .toBe(true);
}

function workspaceBackupFixture() {
  return {
    kind: 'HOSPITAL_WORKSPACE_BACKUP',
    version: 1,
    appId: 'hospital-workspace',
    createdAt: '2026-07-30T00:00:00.000Z',
    schemaVersion: 7,
    source: {},
    stores: {
      appSettings: [
        {
          key: 'placesConfig',
          items: [{ placeId: 'place_1', name: '旧グループ', showNextVisit: false }],
          updatedAt: 1,
        },
        {
          key: 'roundsConfig',
          closingPreset: 'A: 著変なし',
          textSnippets: [{ id: 'old_snp', label: '旧定型文', body: '旧本文' }],
        },
      ],
      users: [
        { id: 'usr_a', name: '利用者A' },
        { id: 'usr_b', name: '利用者B' },
      ],
      patients: [
        {
          patientId: 'pt_old',
          name: '旧アプリ対象',
          room: '旧位置',
          placeId: 'place_1',
          problems: ['旧問題'],
          createdAt: 1,
        },
      ],
      roundsUserStates: [
        {
          key: 'usr_a::pt_old',
          userId: 'usr_a',
          patientId: 'pt_old',
          standingMemo: 'Aの継続メモ',
          updatedAt: 2,
        },
        {
          key: 'usr_b::pt_old',
          userId: 'usr_b',
          patientId: 'pt_old',
          standingMemo: 'Bの継続メモ',
          confirmedNote: 'Bの清書',
          updatedAt: 3,
        },
      ],
      noteDocuments: [],
      noteSettings: [],
      roundsUserSettings: [],
    },
    localStorage: {},
    counts: {},
  };
}

test.beforeEach(async ({ page }) => {
  // Playwright creates an isolated BrowserContext per test, so IndexedDB is fresh here.
  await openFreshApp(page);
});

test('初回プリセットを確認し、対象追加後にステータスを未→途中→済へ進められる', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByText('回診メモ', { exact: true })).toBeVisible();
  await expect(page.getByText('日報', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'QRで受け取る', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'QR送信', exact: true }).first().click();
  const templateQrDialog = page.getByRole('dialog', { name: 'テンプレートをQRで送る' });
  await expectRenderedQr(templateQrDialog.locator('canvas'));
  await templateQrDialog.getByRole('button', { name: '閉じる', exact: true }).click();

  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await addSubject(page);

  await page.getByRole('button', { name: '未', exact: true }).click();
  await expect(page.getByRole('button', { name: '途中', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '途中', exact: true }).click();
  await expect(page.getByRole('button', { name: '済', exact: true })).toBeVisible();
});

test('S本文から定型清書を作成し、1ページのQRとして表示できる', async ({ page }) => {
  await addSubject(page);
  await page.getByRole('button', { name: SUBJECT_NAME }).click();

  await page.getByLabel('(S)', { exact: true }).fill('食欲低下あり');
  await page.getByRole('button', { name: '定型清書', exact: true }).click();

  const confirmedNote = page.getByLabel('清書', { exact: true });
  await expect(confirmedNote).toHaveValue(/\(S\)\n食欲低下あり/);
  await expect(confirmedNote).toHaveValue(/\(A\)\n著変なし/);

  await page.getByRole('button', { name: 'QR表示', exact: true }).click();
  const qrDialog = page.getByRole('dialog', { name: 'QR表示' });
  const canvas = qrDialog.locator('.tm-qr-canvas-wrap canvas');
  await expectRenderedQr(canvas);
  await expect(qrDialog.getByText('1 / 1 ページ', { exact: true })).toBeVisible();
});

test('JSONバックアップを書き出し、全削除後に同じデータを復元できる', async ({ page }) => {
  await addSubject(page);
  await openSettings(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONバックアップを書き出す' }).click();
  const download = await downloadPromise;
  await expect(download.suggestedFilename()).toMatch(/^template-memo-backup-\d{8}\.json$/);
  const backupPath = await download.path();

  await page.getByRole('button', { name: '全データを削除して初期状態に戻す' }).click();
  const wipeDialog = page.getByRole('dialog', { name: '全データを削除しますか？' });
  await wipeDialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(wipeDialog).toBeHidden();
  await expect(page.getByText('初期状態に戻しました', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: SUBJECT_NAME })).toHaveCount(0);
  await openSettings(page);

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'JSONバックアップから復元する' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(backupPath);

  const restoreDialog = page.getByRole('dialog', { name: 'バックアップから復元しますか？' });
  await restoreDialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(restoreDialog).toBeHidden();
  await expect(page.getByText('復元しました', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: SUBJECT_NAME })).toBeVisible();
});

test('旧ワークスペースはユーザーを選び、既存データを残して追記できる', async ({ page }) => {
  await addSubject(page, '既存対象');
  await openSettings(page);

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'ワークスペースから移行（旧アプリ）' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'hospital-workspace-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(workspaceBackupFixture()), 'utf8'),
  });

  const preview = page.getByRole('dialog', { name: '旧ワークスペースからの移行' });
  await expect(preview).toContainText('対象 1 件 / グループ 1 件 / 定型文 1 件');
  await preview.getByLabel('利用者B', { exact: true }).check();
  await preview.getByRole('button', { name: '既存データへ追加', exact: true }).click();

  const confirm = page.getByRole('dialog', {
    name: '旧ワークスペースのデータを追加しますか？',
  });
  await confirm.getByRole('button', { name: '既存データへ追加', exact: true }).click();
  await expect(page.getByText('対象 1 件・グループ 1 件・定型文 1 件を追加しました')).toBeVisible();

  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: '既存対象' })).toBeVisible();
  await page.getByRole('button', { name: '旧アプリ対象' }).click();
  await expect(page.getByLabel('申し送り・継続メモ', { exact: true })).toHaveValue('Bの継続メモ');
  await expect(page.getByLabel('清書', { exact: true })).toHaveValue('Bの清書');
});
