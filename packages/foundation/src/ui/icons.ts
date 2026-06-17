/*
 * Lucide ISC License
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
 * Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with
 * or without fee is hereby granted, provided that the above copyright notice and this
 * permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD
 * TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN
 * NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
 * CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
 * PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * アイコン概念トークン（正本 = apex shared/icons.js の CONCEPT + PATHS）。
 * 形名ではなく「意味」で参照する（icon("share") など）。
 * 新概念は勝手に足さず、まず既存トークンの再利用を検討する。
 * Icon.tsx はこのモジュールから IconName 型とパスデータを受け取る。
 */

/**
 * 概念トークン。意味 → グリフキー の対応。
 * 同じ意味で複数グリフを増やさない（正本 icons.js の CONCEPT と同期する）。
 */
export const CONCEPT = {
  share: 'people', // チームへの申し送り / 共有
  memo: 'memo', // 書類 / メモ / プロブレムリスト
  scan: 'camera', // QR スキャン
  qr: 'qr', // QR 表示
  home: 'home', // ホーム
  edit: 'pencil', // 編集
  delete: 'trash', // 削除
  add: 'plus', // 追加
  close: 'close', // 閉じる
  settings: 'gear', // 設定
  help: 'help', // ヘルプ
  tag: 'tag', // タグ
  expand: 'chevronDown', // 展開 / シェブロン下
  // ledger 由来の追加概念
  alert: 'alert', // 警告 / エラー
  check: 'check', // チェック / 完了
  sprout: 'sprout', // 芽（個人カテゴリアイコン）
  chevronRight: 'chevronRight', // シェブロン右（ドリルダウン）
  archive: 'archive', // アーカイブ
  restore: 'restore', // 復元
  list: 'list', // 一覧
  chart: 'chart', // グラフ
  wallet: 'wallet', // 財布 / 支払い手段
  income: 'income', // 収入
  expense: 'expense', // 支出
  transfer: 'transfer', // 振替
  reverse: 'reverse', // 逆仕訳
  calendar: 'calendar', // カレンダー
  trending: 'trending', // トレンド
  adjust: 'adjust', // 調整 / スライダー
  menu: 'menu', // メニュー（ハンバーガー）
  search: 'search', // 検索
  download: 'download', // ダウンロード
  upload: 'upload', // アップロード
  play: 'play', // 再生 (自動送り開始)
  pause: 'pause', // 一時停止 (自動送り停止)
} as const;

export type IconName = keyof typeof CONCEPT;
