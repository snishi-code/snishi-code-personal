/*
 * ヘッダー: 左=ホーム / 中央=現在の期間コンテキスト表示 / 右=≡(メニュー)。
 * 中央はデータ抽出条件（期間）を小さく表示するだけ。タップで軽量ピッカーを開いて切り替える:
 *   月表示: 「2026年 ▾ / 6月 ▾」   年表示: 「2026年 ▾ / 年全体 ▾」   全期間: 「全期間 ▾」
 * 前後ボタンや粒度トグルなどの操作群はヘッダーに常設しない（操作はピッカー内で行う）。
 * 期間は App の正本 state（ホーム/財務諸表/仕訳で共有）。入力導線はホームに集約。
 */
import { useState } from 'react';
import { Icon } from './Icon';
import { PeriodMonthPicker, PeriodYearPicker } from './PeriodPickers';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import type { ReportPeriod } from '../domain/reportPeriod';

export function Header({
  period,
  today,
  years,
  onPeriodChange,
  onHome,
  onMenu,
}: {
  period: ReportPeriod;
  today: string;
  years: number[];
  onPeriodChange: (p: ReportPeriod) => void;
  onHome: () => void;
  onMenu: () => void;
}) {
  const [picker, setPicker] = useState<'year' | 'month' | null>(null);

  const yearLabel =
    period.mode === 'all' ? t('period.allPeriod') : t('period.yearUnit', { year: period.year });
  const monthLabel =
    period.mode === 'month' ? t('period.monthUnit', { month: period.month }) : t('period.fullYear');

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <button
          type="button"
          className="icon-btn"
          onClick={onHome}
          aria-label={t('header.home')}
          data-ui={UI.nav.home}
        >
          <Icon name="home" />
        </button>

        <div className="period-context">
          <button
            type="button"
            className="period-context__chip"
            onClick={() => setPicker('year')}
            aria-haspopup="dialog"
            aria-label={`${yearLabel} — ${t('period.openYear')}`}
            data-ui={UI.period.yearTrigger}
          >
            <span className="period-context__text">{yearLabel}</span>
            <Icon name="chevronDown" size={14} />
          </button>
          {period.mode !== 'all' ? (
            <>
              <span className="period-context__sep" aria-hidden="true">
                /
              </span>
              <button
                type="button"
                className="period-context__chip"
                onClick={() => setPicker('month')}
                aria-haspopup="dialog"
                aria-label={`${monthLabel} — ${t('period.openMonth')}`}
                data-ui={UI.period.monthTrigger}
              >
                <span className="period-context__text">{monthLabel}</span>
                <Icon name="chevronDown" size={14} />
              </button>
            </>
          ) : null}
        </div>

        <button
          type="button"
          className="icon-btn"
          onClick={onMenu}
          aria-label={t('a11y.openMenu')}
          aria-haspopup="menu"
          data-ui={UI.nav.menuButton}
        >
          <Icon name="menu" />
        </button>
      </div>

      {picker === 'year' ? (
        <PeriodYearPicker
          period={period}
          years={years}
          onChange={onPeriodChange}
          onClose={() => setPicker(null)}
        />
      ) : null}
      {picker === 'month' ? (
        <PeriodMonthPicker
          period={period}
          today={today}
          onChange={onPeriodChange}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </header>
  );
}
