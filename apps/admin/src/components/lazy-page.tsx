import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';
import { reportError } from '../api/client';
import { Button, Loading } from './ui';

type BoundaryProps = {
  children: ReactNode;
  title: string;
  retry: () => void;
  frame: (content: ReactNode) => ReactNode;
};

/** 每个页面独立处理加载和渲染失败，其他已打开页签保留组件与表单状态。 */
class PageBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  /** 资源加载或页面渲染异常后显示局部恢复入口。 */
  static getDerivedStateFromError() {
    return { failed: true };
  }

  /** 技术日志只记录页面标识和错误信息，不携带表单或业务响应。 */
  componentDidCatch(error: Error) {
    reportError(`load-or-render-admin-page:${this.props.title}`, error);
  }

  /** 用户重试时替换失败的页面实例，并恢复当前边界的加载显示。 */
  retry() {
    this.props.retry();
    this.setState({ failed: false });
  }

  /** 重试只重建失败页面；部署后旧资源失效时保留用户主动刷新入口。 */
  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.frame(
      <div className="request-error" role="alert">
        <p>{this.props.title}暂时无法打开，请重试加载。</p>
        <p>若仍无法打开，可刷新页面。未保存的输入可能需要重新填写。</p>
        <div className="row-actions">
          <Button onClick={() => this.retry()}>重试加载</Button>
          <Button onClick={() => window.location.reload()}>刷新页面</Button>
        </div>
      </div>,
    );
  }
}

/** 延迟加载页面模块；每次重试使用新的 lazy 实例，避免重复读取已缓存的失败结果。 */
export function createLazyPage<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  title: string,
  renderFrame?: (content: ReactNode, props: Props) => ReactNode,
) {
  /** 页面实例只在首次打开时装载，隐藏页签继续保留同一个子组件实例。 */
  function LazyPage(props: Props) {
    const [Page, setPage] = useState(() => lazy(load));

    /** 仅在用户明确重试时更新组件身份，不在普通渲染或切换页签时重建。 */
    function retry() {
      setPage(() => lazy(load));
    }

    /** 弹窗入口的加载和失败状态保留关闭能力，普通页使用原有内容区域。 */
    function frame(content: ReactNode): ReactNode {
      return renderFrame ? renderFrame(content, props) : content;
    }

    return (
      <PageBoundary title={title} retry={retry} frame={frame}>
        <Suspense fallback={frame(<Loading label={`正在打开${title}…`} />)}>
          <Page {...props} />
        </Suspense>
      </PageBoundary>
    );
  }

  return LazyPage;
}
