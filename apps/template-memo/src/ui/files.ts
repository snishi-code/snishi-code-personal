/*
 * ローカルファイルの書き出し / 読み込み（端末内のみ・外部送信なし）。
 * バックアップ / テンプレート JSON の入出力窓口はこの 2 関数へ集約する。
 * fetch 等は一切使わない（AGENTS.md の no-exfil 不変条件）。
 */

/** テキストを filename でダウンロード保存する（Blob + a[download]）。 */
export function downloadTextFile(filename: string, text: string): void {
  const mime = filename.endsWith('.json') ? 'application/json' : 'text/plain';
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari 系はクリック直後の revoke で失敗することがあるため少し遅らせる。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * ファイル選択ダイアログを開いてテキストを読む。キャンセルは null を resolve、
 * 読み取り失敗は reject（呼び出し側の catch でエラー通知する = fail-closed）。
 * input[type=file] を動的生成する。cancel イベントは現行の主要ブラウザで発火する。
 */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let done = false;
    const cleanup = () => {
      done = true;
      input.remove();
    };
    const finish = (result: { name: string; text: string } | null) => {
      if (done) return;
      cleanup();
      resolve(result);
    };
    const fail = (e: unknown) => {
      if (done) return;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) {
        finish(null);
        return;
      }
      file.text().then((text) => finish({ name: file.name, text }), fail);
    });
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}
