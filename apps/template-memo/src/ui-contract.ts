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
    tags: 'detail.tags', // ヘッダー直下のタグ行 (表示 + その場で付け外し)
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
  // 継続メモ (患者ごとの独立 textarea)
  memo: {
    standing: { card: 'memo.standing.card', input: 'memo.standing.input' },
  },
  // テンプレート投影の入力欄 (患者ごとに projectedValues へ保存)
  projection: {
    card: 'projection.card',
    section: 'projection.section',
    placement: 'projection.placement',
    field: 'projection.field', // 各入力要素・選択チップ
    freeText: 'projection.freeText', // freeText の場所に出る自由入力 textarea
    normalBtn: 'projection.normalBtn',
    oncall: 'projection.oncall',
    menu: 'projection.menu',
    menuDialog: 'projection.menu.dialog',
    sheet: 'projection.sheet',
    sheetSave: 'projection.sheet.save',
  },
  templateEdit: {
    view: 'templateEdit.view',
    section: 'templateEdit.section',
    placement: 'templateEdit.placement',
    frame: 'templateEdit.frame',
    placementFormat: 'templateEdit.placement.format',
    addFormat: 'templateEdit.placement.add',
    display: 'templateEdit.display',
    save: 'templateEdit.save',
  },
  frameEdit: {
    view: 'frameEdit.view',
    section: 'frameEdit.section',
    field: 'frameEdit.field',
    save: 'frameEdit.save',
  },
  formatEdit: {
    view: 'formatEdit.view',
    item: 'formatEdit.item',
    field: 'formatEdit.field',
    kind: 'formatEdit.kind',
    option: 'formatEdit.option',
    save: 'formatEdit.save',
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
    builderSection: 'settings.builder.section',
    builderSources: 'settings.builder.sources',
    builderPrompt: 'settings.builder.prompt',
    builderResponse: 'settings.builder.response',
    builderPreviewOpen: 'settings.builder.preview.open',
    builderPreview: 'settings.builder.preview',
    builderReuse: 'settings.builder.reuse', // 候補確認画面の「既存を再利用/統合」注記
    builderApply: 'settings.builder.apply',
    templateSection: 'settings.templates.section',
    frameSection: 'settings.frames.section',
    formatSection: 'settings.formats.section',
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
    // 一時: 旧 hospital-workspace からの単発移行 (移行完了後に削除する)。
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
