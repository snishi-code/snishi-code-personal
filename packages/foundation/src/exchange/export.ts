// 移植元: simple-ledger src/data/exportImport.ts の export 部分の汎用化

/** 交換用パッケージを整形 JSON にする(手動 diff・監査しやすさのため整形)。 */
export function buildExportText(pkg: unknown): string {
  return JSON.stringify(pkg, null, 2);
}

/**
 * ダウンロード用ファイル名 `prefix_YYYY-MM-DDTHH-mm-ss.json`(端末ローカル生成・外部送信なし)。
 * prefix はファイル名に安全な文字だけ残す(空になったら 'export')。
 */
export function buildExportFileName(prefix: string, now: Date = new Date()): string {
  const safe = prefix.replace(/[^\p{L}\p{N}_-]/gu, '') || 'export';
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `${safe}_${stamp}.json`;
}
