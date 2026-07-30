// QR 表示の共通定数。旧 QrCardBody / QrDialog / QrReceiveDialog (端末間QRの送受信ダイアログ) は
// 端末間QRの撤去 (2026-07-15 軽量化) で廃止した。残っているのは電子カルテ転記QR
// (DetailQrDialog) が使う自動送り間隔の定数のみ (マジックナンバー禁止)。

/** 自動ページ送り間隔 (ms)。電子カルテ端末のカメラで安定して読める速度。 */
export const QR_AUTO_ADVANCE_MS = 900;
