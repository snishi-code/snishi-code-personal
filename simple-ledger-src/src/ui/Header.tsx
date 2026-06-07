/*
 * ヘッダー: 左=ホーム / 中央=期間コントロール / 右=≡(メニュー)。
 * 中央では年/月/年全体/全期間を「直接」操作できる:
 *   - ‹ › … 現在の粒度ぶん前後に移動（月別なら月、年別なら年。全期間は移動なし）。
 *   - 月 / 年 / 全期間 … 粒度の直接切替（年・月はなるべく保持）。
 *   - 中央ラベル … 期間メニューを開く（数十年先など正確な年/月選択の補助。主導線ではない）。
 * 期間は App の正本 state（ホーム/財務諸表/仕訳で共有）。入力導線はホームに集約しヘッダーに + は置かない。
 */
import { Icon } from './Icon';
import { t } from '../i18n';
import { UI } from '../ui-contract';
import {
  periodLabel,
  stepPeriod,
  withGrain,
  type PeriodGrain,
  type ReportPeriod,
} from '../domain/reportPeriod';

const GRAINS: {
  grain: PeriodGrain;
  labelKey: 'period.toMonth' | 'period.toYear' | 'period.toAll';
  ui: string;
}[] = [
  { grain: 'month', labelKey: 'period.toMonth', ui: UI.period.toMonth },
  { grain: 'year', labelKey: 'period.toYear', ui: UI.period.toYear },
  { grain: 'all', labelKey: 'period.toAll', ui: UI.period.toAll },
];

export function Header({
  period,
  today,
  onPeriodChange,
  onHome,
  onOpenPeriod,
  onMenu,
}: {
  period: ReportPeriod;
  today: string;
  onPeriodChange: (p: ReportPeriod) => void;
  onHome: () => void;
  onOpenPeriod: () => void;
  onMenu: () => void;
}) {
  const isAll = period.mode === 'all';
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

        <div className="app-header__center">
          <div className="period-stepper">
            <button
              type="button"
              className="icon-btn"
              onClick={() => onPeriodChange(stepPeriod(period, -1))}
              disabled={isAll}
              aria-label={t('period.prev')}
              data-ui={UI.period.prev}
            >
              <Icon name="chevronLeft" size={18} />
            </button>
            <button
              type="button"
              className="app-header__period"
              onClick={onOpenPeriod}
              aria-haspopup="dialog"
              aria-label={`${periodLabel(period)} — ${t('period.open')}`}
              data-ui={UI.period.button}
            >
              <span className="app-header__name">{periodLabel(period)}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => onPeriodChange(stepPeriod(period, 1))}
              disabled={isAll}
              aria-label={t('period.next')}
              data-ui={UI.period.next}
            >
              <Icon name="chevronRight" size={18} />
            </button>
          </div>

          <div className="segmented period-grain" role="group" aria-label={t('period.grainSwitch')}>
            {GRAINS.map((g) => (
              <button
                key={g.grain}
                type="button"
                aria-pressed={period.mode === g.grain}
                className="segmented__btn"
                onClick={() => onPeriodChange(withGrain(period, g.grain, today))}
                data-ui={g.ui}
              >
                {t(g.labelKey)}
              </button>
            ))}
          </div>
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
    </header>
  );
}
