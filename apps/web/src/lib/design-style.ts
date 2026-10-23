export type DesignStyle = 'minimal' | 'warm';
type DesignStyleState = Readonly<{ style: DesignStyle; error: string | null }>;

const DESIGN_STYLE_STORAGE_KEY = 'sesame-web-design-style';
const defaultState: DesignStyleState = { style: 'minimal', error: null };
let currentState: DesignStyleState = defaultState;
let initialized = false;
const listeners = new Set<() => void>();

/** 仅识别网页支持的设计风格，旧值或损坏的本地值回退到极简清单。 */
function normalizeDesignStyle(value: string | null): DesignStyle {
  return value === 'warm' ? 'warm' : 'minimal';
}

/** 本地偏好只影响网页，读取失败时提供默认值与可见的恢复提示。 */
function readDesignStyle(): DesignStyleState {
  try {
    return { style: normalizeDesignStyle(localStorage.getItem(DESIGN_STYLE_STORAGE_KEY)), error: null };
  } catch (error) {
    console.error('读取网页设计风格失败', { storageKey: DESIGN_STYLE_STORAGE_KEY, error });
    return { style: 'minimal', error: '暂时无法读取已保存的风格，已使用极简清单。你仍可在这里切换。' };
  }
}

/** 独立更新设计风格属性，不修改控制明暗和系统跟随的显示模式属性。 */
function applyDesignStyle(style: DesignStyle): void {
  try {
    document.documentElement.dataset.designStyle = style;
  } catch (error) {
    console.error('应用网页设计风格失败', { style, error });
    throw new Error('暂时无法应用这个风格，请重新打开页面后再试。', { cause: error });
  }
}

/** 向当前页面的控件广播同一份状态，存储失败时也保留已经应用的本次选择。 */
function publishDesignStyle(next: DesignStyleState): void {
  currentState = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('通知网页设计风格变化失败', { style: next.style, error });
    }
  }
}

/** 在首屏渲染前读取并应用偏好，避免页面先展示另一套风格。 */
export function initializeDesignStyle(): DesignStyleState {
  const saved = readDesignStyle();
  initialized = true;
  try {
    applyDesignStyle(saved.style);
    publishDesignStyle(saved);
  } catch (error) {
    publishDesignStyle({
      style: currentState.style,
      error: error instanceof Error ? error.message : '暂时无法应用网页风格，请重新打开页面。',
    });
  }
  return currentState;
}

/** 立即应用选择后尝试保存；浏览器拒绝存储时明确说明本次选择尚未持久化。 */
export function setDesignStyle(style: DesignStyle): void {
  try {
    applyDesignStyle(style);
  } catch (error) {
    publishDesignStyle({
      style: currentState.style,
      error: error instanceof Error ? error.message : '暂时无法应用网页风格，请重试。',
    });
    return;
  }
  initialized = true;
  try {
    localStorage.setItem(DESIGN_STYLE_STORAGE_KEY, style);
    publishDesignStyle({ style, error: null });
  } catch (error) {
    console.error('保存网页设计风格失败', { style, storageKey: DESIGN_STYLE_STORAGE_KEY, error });
    publishDesignStyle({
      style,
      error: '风格已在当前页面生效，但浏览器未能保存。重新打开页面后可能恢复原来的风格。',
    });
  }
}

/** React 读取稳定快照；独立挂载设置页时也能读取正确的初始偏好。 */
export function getDesignStyleSnapshot(): DesignStyleState {
  if (!initialized) initializeDesignStyle();
  return currentState;
}

/** 注册当前页面的风格监听，组件卸载后释放订阅。 */
export function subscribeDesignStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 服务端渲染使用固定默认快照，浏览器接管后再读取本地偏好。 */
export function getServerDesignStyleSnapshot(): DesignStyleState {
  return defaultState;
}
