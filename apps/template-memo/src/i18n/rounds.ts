// 日本語 UI 文言カタログ (唯一の正本)。コピー移植した rounds UI が描画するユーザー向け文言はすべてここに集める。
// 方針 (コピー元: hospital-workspace の rounds surface カタログ):
//   - 静的文言は文字列リテラル。動的文言 (補間あり) はアロー関数にする。
//   - キーは領域ごとに名前空間化し、TS の補完・hover で読めるようにする (生キー文字列を散らさない)。
//   - キー名・ネスト構造はコピー元のまま変えない (コンポーネントの参照面とコード識別子は不変)。
//   - 値は 2026-07-30 に中立語化した: 患者→対象 / 病棟・場所→グループ / 回診・診察→ラウンド /
//     部屋→位置 / 患者ID→管理ID / 転棟→グループ移動 / 退院→アーカイブ / 電子カルテ→転記(先) /
//     プロブレム→問題。
//   - クリア対象の説明はコピー元の「設定で選べる」から本アプリの固定ポリシー (domain/clearPolicy.ts)
//     に合わせて事実を書き換えた。
//   - 剥離済み機能 (AI / 担当者 / 共有タグ / 研究ログ / ユーザー管理 / 次回ラウンド日) の未参照キーは
//     削除済み。本アプリ固有 (templateQr / tpl / settings.template 以下など) は旧 ja.ts から統合した。

// ── App shell 用 (コピー元: hospital-workspace/src/i18n/ja.ts の boot/shell 抜粋) ──
// 下の rounds カタログ (ja) と合わせて s として export する。

export const s = {
  boot: {
    loading: '読み込み中…',
    initFailed: (msg: string) => `初期化に失敗しました: ${msg}`,
  },
  shell: {
    wardFallback: 'グループ',
    archiveViewLabel: 'アーカイブ',
    settingsLabel: '設定',
    exit: {
      title: 'アプリを終了しますか？',
      body: '入力中の内容は端末内に保存されています。',
      confirm: '終了',
    },
  },
  app: {
    title: 'テンプレメモ',
  },

  // 問題リスト / メモ (テンプレートとは別構造の対象ごと独立データ)
  panel: {
    problem: '問題リスト',
  },

  memo: {
    // 今回メモ / 継続メモ (対象ごとの独立メモ。今回=ラウンド開始でクリア / 継続=残す)
    visit: {
      label: '今回メモ',
      placeholder: '今回のラウンドのメモ。音声入力した内容や転記先へ渡したい内容。',
    },
    standing: {
      label: '継続メモ',
      placeholder: '次回以降も残したい個人メモ。',
    },
  },

  // 共通
  common: {
    cancel: 'キャンセル',
    close: '閉じる',
    delete: '削除',
    edit: '編集',
    save: '保存',
    loading: '読み込み中…',
  },
  save: {
    failed: '保存に失敗しました。端末の空き容量をご確認ください',
  },
  // 例外表示のフォールバック文言 (errorText の既定値)。
  toast: {
    error: 'エラーが発生しました',
    saveFailed: '保存できませんでした（データは変更されていません）',
  },

  // ヘッダー / ナビ
  header: {
    home: 'ホーム',
    settings: '設定',
  },

  // ホーム
  home: {
    start: {
      btn: 'ラウンド開始',
      tooltip: '新しいラウンドを開始（記録をクリア）',
      confirm:
        '新しいラウンドを開始します。前回の記録をクリアしてよろしいですか？\n（ステータス（青以外）・今回メモ・フォーム値をクリアします。問題リスト・継続メモ・タグは残ります）',
    },
    patientQr: {
      title: 'この対象の転記用QRを表示',
      aria: (label: string) => `${label} の転記用QRを表示`,
    },
    statusBtn: { aria: (label: string) => `${label} のステータスを変更` },
    statusPicker: {
      aria: 'ステータスを選択',
      legend: '白 未 / 黄 途中 / 緑 済 / 灰 転記済 / 青 特記',
      note: {
        green: '緑・灰は今回のラウンドが済んだ対象の目印です。',
        blue: '青は特記・持ち越し用で、ラウンド開始でもクリアされません。',
        clear: 'ラウンド開始で青以外の色はクリアされます。',
      },
    },
  },

  // ステータス (固定意味: 白=未 / 黄=途中 / 緑=済 / 灰=転記済 / 青=特記)。
  // StatusPicker の aria-label / title (色名だけだと意味が伝わらないため意味を併記する)。
  tagStatus: {
    none: '白（未）',
    yellow: '黄（途中）',
    green: '緑（済）',
    gray: '灰（転記済）',
    blue: '青（特記）',
  },

  // 対象ヘッダ / 編集
  patientSheet: {
    title: '対象',
    editAria: (label: string) => `${label}（タップして対象情報を編集）`,
    status: 'ステータス',
    room: '位置',
    name: '名前',
    // タグ (選択 / フィルタ / 管理)
    tags: 'タグ',
  },

  detail: {
    // detail.nav.prev / detail.nav.next は廃止 (前/次ボタン撤去・対象切替は横スワイプ)。
    home: { aria: 'ホームへ戻る' },
    // 対象画面 QR (転記用・平文)。対象詳細内の日本語ボタンで開く。
    emrQr: { btn: '転記用QRを表示' },
    qr: {
      dialogAria: '転記用QR',
      preview: { summary: '本文を確認' },
    },
    // テンプレートの群 (ProjectionFormCard) 用。
    noteInput: '入力',
    fractionPlaceholder: '120/80',
    normalCheck: {
      aria: '正常',
      input: (value: string) => `長押しで正常文を入力: ${value}`,
      clear: '長押しで正常文を解除（未入力に戻す）',
      edit: '入力済み（長押しで編集）',
    },
    sheetSave: '保存',
    menuOpen: (place: string) => `${place}のメニューを開く`,
    menuTitle: (place: string) => `${place}のフォーマット`,
  },

  patient: {
    // 対象の管理 (グループ移動 / アーカイブ / 復帰 / 完全削除)
    lifecycle: { actions: { title: '対象の管理' } },
    move: 'グループを移動',
    add: {
      label: '対象を追加する',
      aria: '対象を追加する',
      title: '新しい対象を追加して名前・位置を入力する',
      failed: '対象の追加に失敗しました',
    },
    archive: {
      label: 'アーカイブ（終了）',
      confirm:
        'この対象をアーカイブ（終了）します。一覧から消えますが、作業状態ごと保持され「戻す」で復帰できます。よろしいですか？',
    },
    delete: {
      permanent: {
        confirm: 'この対象を完全に削除します。作業状態ごと消え、元に戻せません。よろしいですか？',
      },
      failed: '操作に失敗しました',
      permanentBtn: '完全削除',
    },
    restore: {
      label: '戻す',
      failed: '復帰に失敗しました',
      title: '戻すグループを選ぶ',
    },
  },

  // グループ移動 (place 属性の変更のみ。作業状態は対象に追従する)
  move: {
    title: '移動先のグループを選ぶ',
    list: { empty: '他のグループがありません' },
    failed: '移動に失敗しました',
  },

  // 問題リスト (対象ごとの独立データ)
  problem: {
    placeholder: '問題',
    input: { aria: (n: number) => `問題 #${n}` },
    add: '問題を追加',
    delete: {
      aria: (n: number) => `問題 #${n} を削除`,
      confirm: (text: string) => `「${text}」を削除します。よろしいですか？`,
    },
    move: {
      up: { aria: (n: number) => `問題 #${n} を上へ移動` },
      down: { aria: (n: number) => `問題 #${n} を下へ移動` },
    },
    // アーカイブ中は read-only。内容は見えるが編集不可。
    readonly: { note: 'アーカイブ中は編集できません（復帰すると編集できます）' },
  },

  // QR 共通
  qr: {
    autoplay: {
      pause: '自動送りを一時停止',
      play: '自動送りを再開',
    },
    prev: { tooltip: '前' },
    next: { tooltip: '次' },
    render: { failed: 'QR を描画できませんでした' },
    page: (n: number, total: number) => `${n} / ${total} ページ`,
    autoPage: '自動送り',
  },

  // 対象画面のラウンド入力カード (テンプレートの常設フォーム)。
  projection: {
    title: 'ラウンド入力',
  },

  // テンプレート定義のフィールド名 (QR 受信プレビューの見出し)。
  tpl: {
    name: 'テンプレート名',
    // 作者語彙は「場所」(セクションはコード識別子のみ)。
    sections: '場所',
    includeProblems: '合成に問題リストを含める',
    includeHandover: '合成に申し送りを含める',
    memoSection: '今回メモを入れる場所',
    memoSectionNone: '入れない',
    sectionAdd: '場所を追加',
    sectionTitle: '場所の見出し（例 (S)・【今日やったこと】）',
    sectionNormal: '正常文（空欄を補う文。例 著変なし）',
    sectionFreeText: '自由本文欄を持つ',
    formats: 'フォーマット',
    groupAdd: 'フォーマットを追加',
    groupName: 'フォーマット名（例 バイタル）',
    groupDisplay: '配置',
    groupDisplayAlways: '展開',
    groupDisplayOncall: '呼び出し',
    groupDisplayMenu: 'メニュー',
    groupJoiner: '項目間の区切り',
    groupLabelSep: 'ラベルと値の区切り',
    items: '項目',
    itemAdd: '項目を追加',
    itemLabel: 'ラベル（例 肺音）',
    itemKind: '種類',
    itemKindText: '文章（正常文）',
    itemKindNumber: '数値',
    itemKindFraction: '分数（120/80 型）',
    itemKindSelect: '選択',
    itemUnit: '単位（例 mmHg）',
    itemNormal: '正常文（例 明らかなラ音なし）',
    itemOptions: '選択肢',
    itemOptionDefault: '選択肢',
    itemOption: (n: number) => `選択肢 ${n}`,
    itemOptionAdd: '選択肢を追加',
    itemShowLabel: '合成時にラベルを出す',
    moveUp: '上へ',
    moveDown: '下へ',
    saved: 'テンプレートを保存しました',
    joinerNewline: '改行',
    joinerCommaSpace: 'カンマ + 空白',
    joinerToten: '読点（、）',
    joinerHyphen: 'ハイフン（-）',
    joinerSpace: '空白',
    labelSepColon: 'コロン（：）',
    labelSepSpace: '空白',
    labelSepNone: 'なし',
  },

  // テンプレート QR の受け渡し (送信 / 受信ダイアログ)。
  templateQr: {
    sendTitle: 'テンプレートをQRで送る',
    sendHint: 'テンプレート定義だけを送ります。対象・メモ・設定などのデータは含まれません。',
    errorCompression: 'この環境ではQR用の圧縮を利用できません。',
    errorTemplate: 'テンプレートの形式が不正なためQRを作成できません。',
    errorEncode: 'テンプレートのQRを作成できませんでした。',
    errorDraw: 'QRを描画できませんでした。',
    previousPage: '前のページ',
    nextPage: '次のページ',
    receiveTitle: 'テンプレートをQRで受け取る',
    receiveIntro: '送信側のQRを順不同で読み取れます。全ページが揃うまで保存されません。',
    cameraUnavailable:
      'この環境ではカメラを利用できません。下の入力欄へQRの文字列を貼り付けてください。',
    cameraStart: 'カメラで読み取る',
    cameraStop: 'カメラを停止',
    cameraLabel: 'テンプレートQR読み取り用カメラ',
    cameraFailed: 'カメラを開始できませんでした。権限を確認してください。',
    pasteLabel: 'QR文字列を貼り付け',
    pastePlaceholder: 'RND_TPL で始まる1ページ分を貼り付けます',
    readPage: 'このページを読み取る',
    invalidPage: 'テンプレートQRとして読めないページです。',
    wrongKind: (kind: string) => `別の種類のQRです（${kind}）。入力はそのまま残しています。`,
    duplicate: (got: number, total: number) => `このページは読み取り済みです（${got}/${total}）。`,
    progress: (got: number, total: number) => `${got}/${total} ページを読み取りました。`,
    errorTransport: '圧縮データが壊れているため読み取れません。',
    errorJson: 'テンプレートのJSONが壊れているため読み取れません。',
    errorVersion: '対応していないバージョンのテンプレートQRです。',
    errorIncomplete: 'ページの組み合わせが不正です。最初から読み直してください。',
    errorDecode: 'テンプレートQRを読み取れませんでした。',
    reset: '読み取りをやり直す',
    previewTitle: '保存前の確認',
    counts: (sections: number, formats: number, items: number) =>
      `場所 ${sections} / フォーマット ${formats} / 項目 ${items}`,
    included: '含める',
    excluded: '含めない',
    conflictTitle: '同じIDのテンプレートがあります',
    conflictBody: '既存テンプレートを上書きするか、別テンプレートとして追加します。',
    overwrite: '既存テンプレートを上書き',
    addCopy: '別テンプレートとして追加',
    saveFailed: 'テンプレートを保存できませんでした。',
  },

  io: {
    ws: {
      // place (グループ) の切替/追加/改名/削除
      switch: { failed: 'グループの切替に失敗しました' },
      list: { empty: '登録されたグループはありません' },
      untitled: '(無題)',
      create: {
        placeholder: '例: グループA',
        action: 'グループを追加',
        failed: 'グループの追加に失敗しました',
      },
      rename: {
        title: 'グループの名前を編集',
        failed: 'グループの名前の変更に失敗しました',
      },
      delete: {
        confirm: (name: string) =>
          `グループ「${name}」を削除しますか？（対象が残っているグループは削除できません）`,
        failed: '削除に失敗しました',
      },
    },
  },

  // アーカイブ一覧 (終了した対象。一覧から外して作業状態ごと保持する)
  archive: {
    viewLabel: 'アーカイブ（終了）',
    count: (n: number) => `${n}件`,
    banner:
      'アーカイブ（終了）した対象です。「戻す」でグループへ復帰、「完全削除」でデータごと削除できます。',
    empty: 'アーカイブされた対象はありません',
    detailNote: 'アーカイブ済みの対象です。作業状態は保持されており、戻すとそのまま再開できます。',
  },

  // タグ (選択 / フィルタ / 管理)
  tag: {
    add: {
      title: '新規タグ',
      aria: '新規タグ',
    },
    sheet: { filterTitle: 'タグで絞り込む' },
    placeholder: 'タグ名',
    filter: {
      empty: 'タグが登録されていません',
      clear: {
        label: 'タグ選択をクリア',
        aria: '選択をすべて解除',
      },
    },
  },

  settings: {
    title: {
      tags: 'タグ',
      // 設定: グループ管理 (一覧の見出し)
      workspaces: 'グループの管理',
    },
    tag: {
      placeholder: 'タグ名',
      name: { duplicate: '同じ名前のタグが既にあります' },
      delete: {
        confirm: (name: string) =>
          `タグ「${name}」を削除します。よろしいですか？\n（このタグが付いている対象のタグも一緒に外れます）`,
        aria: (name: string) => `タグ「${name}」を削除`,
      },
      // 色名 → 文言の Record。domain/types の TagColor ('gray' | 'amber') と keyof を一致させ、
      // s.settings.tag.color[color] の型安全な index アクセスで引く (as キャスト不要)。
      color: {
        gray: 'グレー',
        amber: 'アンバー',
      },
    },
    tagGroup: { name: { empty: '(無名)' } },
    // 設定: 巻き戻し (スナップショット復元)
    restore: {
      section: '巻き戻し',
      hint: '「ラウンド開始」・対象の移動・取り込みの直前と、画面を切り替えた時の状態を自動で控えておきます。各行の「戻す」でその時点に戻せます。対象のデータを含むため14日で自動的に消えます。',
      empty: '戻せる控えはまだありません',
      action: '戻す',
      confirm: 'この時点の状態に戻しますか？（今の状態も自動で控えるので、やり直せます）',
      failed: '巻き戻しに失敗しました',
      count: (n: number) => `対象 ${n} 件`,
      reason: {
        clear: '「ラウンド開始」を押す直前',
        move: '対象を移動する直前',
        patientDelete: '対象を削除する直前',
        delete: 'グループを削除する直前',
        import: '取り込みの直前',
        nav: '画面を切り替えた時',
        undo: '巻き戻しの直前',
      },
    },
    // 設定: グループ (一覧・切替・改名・削除・追加をこの場で直接行う)
    ward: {
      hint: 'グループの一覧です。タップで切り替え、鉛筆で名前を変更（対象側の表示も自動で変わります）、ゴミ箱で削除（現在のグループ・対象が残っているグループは削除不可）、下のボタンで追加できます。',
      current: '現在のグループ',
      patientCount: (n: number) => `対象 ${n}件`,
    },
    // 設定: テンプレート (有効切替 / QR送受信 / 削除)
    template: {
      section: 'テンプレート',
      editTitle: 'テンプレートを編集',
      addRound: '回診メモを追加',
      addDaily: '日報を追加',
      addEmpty: '空のテンプレートを作る',
      active: '使用中',
      use: '使用する',
      qrSend: 'QR送信',
      qrReceive: 'QRで受け取る',
      imported: (name: string) => `テンプレートを読み込みました: ${name}`,
      deleteConfirmTitle: 'テンプレートを削除しますか？',
      deleteConfirmBody: (name: string) => `「${name}」を削除します。対象の入力値は消えません。`,
    },
    // 設定: QR 出力 (改行モード)
    qrOutput: {
      section: 'QR出力',
      newlineMode: '改行の変換',
      newlineCrlf: 'CRLF に統一（Windows系の編集欄向け・推奨）',
      newlineLf: '変換しない（元の改行を保持）',
    },
    // 設定: バックアップ (JSON 書き出し / 復元)
    backup: {
      section: 'バックアップ',
      export: 'JSONバックアップを書き出す',
      import: 'JSONバックアップから復元する',
      importConfirmTitle: 'バックアップから復元しますか？',
      importConfirmBody:
        '現在の全データ（対象・グループ・テンプレート・設定）をファイルの内容で置き換えます。この操作は取り消せません。',
      imported: '復元しました',
      importFailed: (reason: string) => `復元できませんでした: ${reason}`,
    },
    // 設定: 旧 hospital-workspace からの単発移行 (追記のみ)
    workspaceImport: {
      section: 'ワークスペースから移行（旧アプリ）',
      pick: 'バックアップJSONを選ぶ',
      previewTitle: '旧ワークスペースからの移行',
      user: '移行するユーザー',
      counts: (subjects: number, groups: number) => `対象 ${subjects} 件 / グループ ${groups} 件`,
      appendOnly:
        '現在のデータは残したまま、上記のデータを追加します。今回メモ・状態・タグ・フォーム値は移行しません。',
      apply: '既存データへ追加',
      imported: (subjects: number, groups: number) =>
        `対象 ${subjects} 件・グループ ${groups} 件を追加しました`,
      failed: (reason: string) => `移行できませんでした: ${reason}`,
      noUsers: '移行できるユーザーが見つかりません',
      noteClosingPreset:
        '旧アプリの締め文は移行していません（テンプレートの正常文へ一般化されたため）。',
    },
    // 設定: 危険な操作 (全削除)
    danger: {
      section: '危険な操作',
      wipe: '全データを削除して初期状態に戻す',
      wipeConfirmTitle: '全データを削除しますか？',
      wipeConfirmBody:
        'すべての対象・グループ・テンプレート・設定を削除して初期状態に戻します。この操作は取り消せません。',
      wiped: '初期状態に戻しました',
    },
    // 操作ガイド
    guide: {
      section: '操作ガイド',
      pending: '操作ガイドは準備中です。',
    },
  },

  // 設定: JSON 書き出し。
  export: {
    saved: 'JSON を保存しました',
    failed: 'データの出力に失敗しました。',
  },

  // グループピッカー
  wsPicker: { title: 'グループ' },
} as const;
