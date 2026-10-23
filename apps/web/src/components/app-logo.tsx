/** 统一展示客户端正式 Logo，保留原始配色、透明背景和安全留白。 */
export function AppLogo({ decorative = false }: { decorative?: boolean }) {
  return (
    <img
      className="app-logo"
      src="/app-logo.svg"
      width={64}
      height={64}
      alt={decorative ? '' : '芝麻记'}
      aria-hidden={decorative || undefined}
      draggable={false}
    />
  );
}
