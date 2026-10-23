import { createRoot } from 'react-dom/client';
import { BrowserSupportNotice, getBrowserSupportIssue } from './browser-support';
import { initializeDesignStyle } from './lib/design-style';
import './styles.css';
import './design-styles.css';

try {
  document.documentElement.dataset.theme = localStorage.getItem('sesame-web-theme') ?? 'system';
} catch {
  document.documentElement.dataset.theme = 'system';
}
initializeDesignStyle();
const root = document.getElementById('root');
if (!root) throw new Error('页面缺少根节点');
const renderer = createRoot(root);
const issue = getBrowserSupportIssue();
if (issue) renderer.render(<BrowserSupportNotice issue={issue} />);
else {
  renderer.render(
    <main className="initial-loading">
      <p role="status">正在打开芝麻记…</p>
    </main>,
  );
  void import('./bootstrap')
    .then(({ Application }) => renderer.render(<Application />))
    .catch(() => {
      renderer.render(
        <main className="fatal-error">
          <h1>页面暂时无法打开</h1>
          <p>请重新加载后再试。</p>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </main>,
      );
    });
}
