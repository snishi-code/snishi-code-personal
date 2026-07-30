// UI contract — テスト (Testing Library / Playwright) が依存してよい data-ui 安定名の名簿。
//
// 規約 (foundation ui/contract.ts):
//   - 第一選択はロール/アクセシブルネーム。data-ui は文言変更で壊れない補助名。
//   - 値は `領域.対象[.動作]`。リテラルを散らさず必ずこの名簿経由で参照する。

export const UI = {
  home: {
    start: 'home.start',
    grid: 'home.grid',
    addPatient: 'home.addPatient',
    patientQr: 'home.patientQr', // ホーム患者行の右端「転記用QR」ボタン
    statusZone: 'home.statusZone', // ホーム患者行の左端ステータスボタン
    actionBar: 'home.actionBar', // 下部固定バー (詳細/設定と共通の枠)
    homeBottom: 'home.home.bottom', // 下部中央: ホーム (現在地のため disabled)
  },
  patient: {
    card: 'patient.card',
    statusOption: 'patient.status.option',
    statusPopup: 'patient.statusPopup', // ホームのステータス変更ポップアップ
    move: 'patient.move',
    editPopup: 'patient.edit.popup',
    name: 'patient.edit.name',
    room: 'patient.edit.room',
  },
  detail: {
    meta: 'detail.meta',
    home: 'detail.home',
    actionBar: 'detail.actionBar',
    // 画面内ボタン (患者固有 = 転記用QR)
    emrQr: 'detail.emrQr', // 患者詳細内「転記用QRを表示」ボタン
    qrDialog: 'detail.qr.dialog',
  },
  problem: {
    card: 'problem.card',
    list: 'problem.list',
    row: 'problem.row',
    input: 'problem.input',
    add: 'problem.add',
    delete: 'problem.delete',
    moveUp: 'problem.moveUp',
    moveDown: 'problem.moveDown',
  },
  // 今回メモ / 継続メモ (患者ごとの独立 textarea)
  memo: {
    visit: { card: 'memo.visit.card', input: 'memo.visit.input' },
    standing: { card: 'memo.standing.card', input: 'memo.standing.input' },
  },
  // テンプレート投影の入力欄 (患者ごとに projectedValues へ保存)
  projection: {
    card: 'projection.card',
    section: 'projection.section',
    group: 'projection.group',
    field: 'projection.field', // 各入力要素・選択チップ
    oncall: 'projection.oncall',
    menu: 'projection.menu',
    menuDialog: 'projection.menu.dialog',
    sheet: 'projection.sheet',
    sheetSave: 'projection.sheet.save',
  },
  qr: {
    canvas: 'qr.canvas',
    pageMeta: 'qr.pageMeta',
    prev: 'qr.prev',
    next: 'qr.next',
    playToggle: 'qr.playToggle',
  },
  settings: {
    view: 'settings.view',
    homeBottom: 'settings.home.bottom',
    actionBar: 'settings.actionBar', // 下部固定バー (詳細/ホームと共通の枠)
    tagList: 'settings.tags.list',
    tagRow: 'settings.tags.row',
    tagDelete: 'settings.tags.delete',
    tagColor: 'settings.tagColor',
    restoreList: 'settings.restore.list',
    restoreRow: 'settings.restore.row',
    restoreAction: 'settings.restore.action',
    restoreDelete: 'settings.restore.delete',
    wardList: 'settings.wards.list',
    wardRow: 'settings.wards.row',
    wardRename: 'settings.wards.rename',
    wardDelete: 'settings.wards.delete',
    wardAdd: 'settings.wards.add',
  },
  picker: {
    wsDialog: 'picker.ws.dialog',
    wsRow: 'picker.ws.row',
    wsAdd: 'picker.ws.add',
    wsRename: 'picker.ws.rename',
    archiveRow: 'picker.archive.row', // アーカイブ一覧ビューへの切替行
  },
  lifecycle: {
    archive: 'lifecycle.archive',
    permanentDelete: 'lifecycle.permanentDelete',
    restore: 'lifecycle.restore',
    restoreDialog: 'lifecycle.restoreDialog',
    moveDest: 'lifecycle.moveDest',
  },
  tags: {
    filterOpen: 'tags.filter.open',
    filterSheet: 'tags.filter.sheet',
    filterOption: 'tags.filter.option',
    selectChip: 'tags.select.chip',
    addBtn: 'tags.add',
  },
} as const;
