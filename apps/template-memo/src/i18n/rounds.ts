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
    // 継続メモ (対象ごとの独立メモ。ラウンド開始でも残す)。
    // 今回分の自由本文は入力フォームの各場所（freeText）が持つ。
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
    duplicate: '複製',
    edit: '編集',
    save: '保存',
    loading: '読み込み中…',
    // 空名の部品の一覧表示用（データには代替名を保存しない）。
    untitled: '(無題)',
    // 複製 IconButton の表示字（複製アイコンが foundation に無いための1字表示）。
    duplicateShort: '複',
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
        '新しいラウンドを開始します。前回の記録をクリアしてよろしいですか？\n（ステータス（青以外）・入力フォームの内容をクリアします。問題リスト・継続メモ・タグは残ります）',
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
    // detail.nav.prev / detail.nav.next は廃止 (前/次ボタン撤去・対象切替はホーム一覧経由のみ)。
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
    // 見出しの無い場所に出る自由入力欄の aria-label (見出しがあれば見出しを使う)。
    freeTextAria: (n: number) => `場所 ${n} の自由入力`,
  },

  componentUsage: (n: number) => `${n}個のテンプレートで使用中（変更はすべてに反映されます）`,
  frameEdit: {
    title: 'フレームを編集',
    name: 'フレーム名',
    saved: 'フレームを保存しました',
  },
  formatEdit: {
    title: 'フォーマットを編集',
    name: 'フォーマット名',
    saved: 'フォーマットを保存しました',
  },
  templateEdit: {
    title: 'テンプレートを編集',
    frame: '使用するフレーム',
    frameChangeHint: 'フレームを変えると配置はリセットされます',
    addFormat: (section: string) => `${section || 'この場所'}へ配置するフォーマット`,
    removePlacement: '外す',
    saved: 'テンプレートを保存しました',
  },

  // フレーム・フォーマット・テンプレート定義のフィールド名。
  tpl: {
    name: 'テンプレート名',
    // 作者語彙は「場所」(セクションはコード識別子のみ)。
    sections: '場所',
    includeProblems: '合成に問題リストを含める',
    includeHandover: '合成に申し送りを含める',
    sectionAdd: '場所を追加',
    sectionTitle: '場所の見出し（例 (S)・【今日やったこと】）',
    sectionNormal: '正常文（空欄を補う文。例 著変なし）',
    sectionFreeText: '自由本文欄を持つ',
    formatAdd: '＋フォーマットを配置',
    placementDisplay: '表示方法',
    placementDisplayAlways: '展開',
    placementDisplayOncall: '呼び出し',
    placementDisplayMenu: 'メニュー',
    formatJoiner: '項目間の区切り',
    formatLabelSep: 'ラベルと値の区切り',
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
    joinerNewline: '改行',
    joinerCommaSpace: 'カンマ + 空白',
    joinerToten: '読点（、）',
    joinerHyphen: 'ハイフン（-）',
    joinerSpace: '空白',
    labelSepColon: 'コロン（：）',
    labelSepSpace: '空白',
    labelSepNone: 'なし',
  },

  // テンプレートパッケージ / フレーム / フォーマットの QR 受け渡し。
  templateQr: {
    sendTitle: '部品をQRで送る',
    sendHint:
      'フレーム・フォーマット・テンプレート部品だけを送ります。グループ・対象・入力値は含まれません。',
    errorCompression: 'この環境ではQR用の圧縮を利用できません。',
    errorEntity: '部品の形式が不正なためQRを作成できません。',
    errorEncode: '共有QRを作成できませんでした。',
    errorDraw: 'QRを描画できませんでした。',
    previousPage: '前のページ',
    nextPage: '次のページ',
    receiveTitle: '部品をQRで受け取る',
    receiveIntro:
      'テンプレート・フレーム・フォーマットのQRを順不同で読み取れます。全ページが揃うまで保存されません。',
    cameraUnavailable:
      'この環境ではカメラを利用できません。下の入力欄へQRの文字列を貼り付けてください。',
    cameraStart: 'カメラで読み取る',
    cameraStop: 'カメラを停止',
    cameraLabel: '部品QR読み取り用カメラ',
    cameraFailed: 'カメラを開始できませんでした。権限を確認してください。',
    pasteLabel: 'QR文字列を貼り付け',
    pastePlaceholder: 'RND_TPL / RND_FRM / RND_FMT で始まる1ページ分を貼り付けます',
    readPage: 'このページを読み取る',
    invalidPage: '部品QRとして読めないページです。',
    wrongKind: (kind: string) => `別の種類のQRです（${kind}）。入力はそのまま残しています。`,
    duplicate: (got: number, total: number) => `このページは読み取り済みです（${got}/${total}）。`,
    progress: (got: number, total: number) => `${got}/${total} ページを読み取りました。`,
    errorTransport: '圧縮データが壊れているため読み取れません。',
    errorJson: '共有データのJSONが壊れているため読み取れません。',
    errorVersion: '対応していないバージョンの共有QRです。',
    errorIncomplete: 'ページの組み合わせが不正です。最初から読み直してください。',
    errorDecode: '共有QRを読み取れませんでした。',
    reset: '読み取りをやり直す',
    previewTitle: '保存前の確認',
    kind: '種類',
    templatePackage: 'テンプレート一式',
    frame: 'フレーム',
    format: 'フォーマット',
    formats: 'フォーマット',
    none: 'なし',
    collisionSafety: '同じIDがある場合は既存データを上書きせず、コピーとして保存します。',
    imported: (kindLabel: string, name: string) => `${kindLabel}を読み込みました: ${name}`,
    saveFailed: '部品を保存できませんでした。',
  },

  builder: {
    sourcesTitle: '文章の例',
    sourcesIntro: '作りたい完成文章を複数貼り付けると、共通する骨組みを見つけやすくなります。',
    memoryOnly: '入力内容はこの端末のメモリだけに保持され、読み込み直すと消えます。',
    sourceLabel: (n: number) => `文章の例 ${n}`,
    sourcePlaceholder: '作りたい完成文章の例を貼り付けます',
    sourceAdd: '文章の例を追加',
    sourceDelete: (n: number) => `文章の例 ${n} を削除`,
    sourcesSave: '文章の例を保存',
    sourcesClear: 'すべてクリア',
    promptTitle: 'AIへの依頼文',
    promptLabel: 'コピーして利用者自身のAIアプリへ貼り付ける文章',
    promptWarning:
      'この文章に氏名・管理ID・住所などが含まれていないか確認してください。\n貼り付け先の AI サービスのデータ取り扱いは、このアプリの管理外です。',
    promptCopy: '依頼文をコピー',
    promptRenew: '依頼文を再作成',
    copied: '依頼文をコピーしました',
    copyFailed: '文章を選んで手動でコピーしてください',
    responseTitle: 'AIの返答',
    responseLabel: 'AIアプリから返されたJSON',
    responsePlaceholder: 'AIの返答をそのまま貼り付けます',
    responseAnalyze: '返答を解析',
    responseStale:
      '文章の例が変わったため、この返答は古くなりました。依頼文を作り直してから貼り直してください。',
    responseClear: '返答をクリア',
    responseReady: '候補を解析しました',
    parseError: {
      empty: '返答を貼り付けてください',
      invalidJson: 'JSONとして読み取れませんでした',
      notObject: '返答のJSONがオブジェクトではありません',
      wrongKind: 'テンプレート作成アシストの返答ではありません',
      wrongVersion: '対応していない版の返答です',
      requestMismatch: '別の依頼への返答です',
      truncated: '返答が途中で切れている可能性があります',
      noSections: '場所が1つも見つかりませんでした',
      tooLarge: (actual: number, max: number) =>
        `返書が長すぎます（${actual.toLocaleString()} / ${max.toLocaleString()} 字）`,
    },
    previewTitle: '登録前の候補確認',
    previewIntro:
      '内容を確認し、不要なフォーマットを外してください。項目の編集や並び替えは登録後にできます。',
    frame: 'フレーム',
    sections: '場所',
    sectionFreeText: '自由本文欄あり',
    sectionNoFreeText: '自由本文欄なし',
    formats: 'フォーマット',
    formatItems: (n: number) => `項目 ${n}件`,
    // 構造が一致する既存部品は新しく作らず再利用する。名前が違っても内容が同じなら再利用対象。
    reuseExisting: (name: string) => `既存『${name}』を再利用`,
    reuseMerged: (n: number) => `同じ内容の候補 ${n} 件を統合`,
    reuseMergedInto: (name: string) => `『${name}』と同じ内容のため統合`,
    placements: '配置',
    placement: (section: string, display: string) => `${section}へ${display}で配置`,
    noPlacement: '配置なし',
    displayAlways: '展開',
    displayOncall: '呼び出し',
    normals: '正常文を持つ項目',
    normalWarning: '正常文は必ず内容を確認してください。',
    normalItem: (format: string, label: string, normal: string) =>
      `${format} / ${label || 'ラベルなし'}: ${normal}`,
    noNormals: '正常文を持つ項目はありません',
    dropped: (n: number) => `取り込めなかったもの ${n}件`,
    noDropped: '取り込めなかったものはありません',
    aiWarnings: 'AIからの注意',
    noAiWarnings: 'AIからの注意はありません',
    apply: '登録する',
    cancel: 'やめる',
    applied: 'テンプレート一式を登録しました',
    applyFailed: 'テンプレート一式を登録できませんでした',
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
    // 設定: 完成文章からフレーム・フォーマット・テンプレート候補を作る補助。
    builder: {
      section: 'テンプレート作成アシスト',
      hint: '文章の例から依頼文を作り、利用者自身のAIアプリで得た返答を確認して登録します。このアプリはAIへ通信しません。入力内容は読み込み直すと消えます。文章の例がないと依頼文は作れません。',
      sources: '1 文章の例',
      sourceCount: (n: number) => (n > 0 ? `${n}件` : '未入力'),
      prompt: '2 AIへの依頼文',
      promptReady: '作成済み',
      promptStale: '要再作成',
      promptUnavailable: '—',
      response: '3 AIの返答',
      responseReady: '解析済み',
      responseStale: '古い返答',
      responseEmpty: '未貼付',
      preview: '候補を確認する',
    },
    // 設定: テンプレート (有効切替 / QR送受信 / 削除)
    template: {
      section: 'テンプレート',
      addRound: '回診メモを追加',
      addDaily: '日報を追加',
      addEmpty: '空のテンプレートを作る',
      active: '使用中',
      use: '使用する',
      qrSend: 'QR送信',
      qrReceive: 'QRで受け取る',
      deleteConfirmTitle: 'テンプレートを削除しますか？',
      deleteConfirmBody: (name: string) => `「${name}」を削除します。対象の入力値は消えません。`,
    },
    frame: {
      section: 'フレーム',
      add: 'フレームを作る',
      usage: (n: number) => `テンプレート ${n}件で使用`,
      deleteConfirmTitle: 'フレームを削除しますか？',
      deleteConfirmBody: (name: string) => `「${name}」を削除します。`,
    },
    format: {
      section: 'フォーマット',
      add: 'フォーマットを作る',
      usage: (n: number) => `テンプレート ${n}件で使用`,
      deleteConfirmTitle: 'フォーマットを削除しますか？',
      deleteConfirmBody: (name: string) => `「${name}」を削除します。`,
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
        '現在のデータは残したまま、上記のデータを追加します。入力フォームの内容・状態・タグは移行しません。',
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
