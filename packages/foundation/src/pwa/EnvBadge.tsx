import { getEnv } from './env';

export function EnvBadge() {
  if (getEnv() !== 'test') return null;
  return (
    <span className="env-badge" aria-label="テスト環境">
      テスト
    </span>
  );
}
