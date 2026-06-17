/*
 * アプリヘッダー(sticky・高さ --header-h)。左/中央/右はスロットで、
 * 中身(期間表示・メニュー等)はアプリが注入する(ここにドメインを持たせない)。
 */
import type { ReactNode } from 'react';

export function AppHeader({
  left,
  center,
  right,
  dataUi,
}: {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  dataUi?: string;
}) {
  return (
    <header className="app-header" data-ui={dataUi}>
      <div className="app-header__inner">
        {left}
        <div className="app-header__center">{center}</div>
        {right}
      </div>
    </header>
  );
}
