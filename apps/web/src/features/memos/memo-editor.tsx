import { useEffect, useRef, useState } from 'react';
import Quill, { Delta, type Range } from 'quill';
import type Embed from 'quill/blots/embed';
import { ImagePlus } from 'lucide-react';
import 'quill/dist/quill.snow.css';
import './memo-editor.css';
import { Button } from '../../components/ui';
import { deltaSchema, logMemoError, type MemoDelta } from './memo-content';
import { loadMemoImage, uploadMemoImage } from './memo-media';

/** 使用 Quill 内置 embed 基类的类型，运行时仍从注册表导入以复用当前实例配置。 */
const EmbedBlot = Quill.import('blots/embed') as typeof Embed;

/**
 * 正文图片 embed：value 为媒体标识，节点先渲染占位，挂载后再异步换取图片字节。
 * 图片只保存在服务端，编辑器与正文 Delta 都不携带图片地址或字节。
 */
class MemoImageBlot extends EmbedBlot {
  static blotName = 'memo_image';
  static tagName = 'span';
  static className = 'memo-image';

  private controller: AbortController | null = null;
  private objectUrl: string | null = null;
  private status: 'idle' | 'loading' | 'ready' = 'idle';
  private disposed = false;

  static create(value: unknown): Node {
    const mediaId = String(value);
    const node = super.create(mediaId) as HTMLElement;
    node.dataset.mediaId = mediaId;
    node.setAttribute('contenteditable', 'false');
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', '图片加载中');
    const placeholder = document.createElement('span');
    placeholder.className = 'memo-image-placeholder';
    placeholder.textContent = '图片加载中…';
    node.append(placeholder);
    return node;
  }

  static value(node: Node): string {
    return (node as HTMLElement).dataset.mediaId ?? '';
  }

  /** 挂载后开始加载，同一节点重复挂载不会重复请求。 */
  attach(): void {
    super.attach();
    if (this.status === 'idle') void this.load();
  }

  detach(): void {
    this.stop();
    super.detach();
  }

  /** 编辑器销毁会整体移除 DOM，不会触发 detach，卸载前需要显式释放。 */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** 加载成功后替换占位；失败时显示不可用文字，图片 op 仍可继续编辑保存。 */
  private async load(): Promise<void> {
    const mediaId = MemoImageBlot.value(this.domNode);
    if (!mediaId) return;
    this.status = 'loading';
    const controller = new AbortController();
    this.controller = controller;
    try {
      const blob = await loadMemoImage(mediaId, controller.signal);
      if (this.disposed || controller.signal.aborted || this.controller !== controller) return;
      if (!blob) {
        this.renderText('图片不可用');
        this.status = 'ready';
        return;
      }
      const url = URL.createObjectURL(blob);
      this.objectUrl = url;
      const image = document.createElement('img');
      image.src = url;
      image.alt = '备忘录图片';
      image.className = 'memo-image-content';
      this.contentNode.replaceChildren(image);
      (this.domNode as HTMLElement).setAttribute('aria-label', '备忘录图片');
      this.status = 'ready';
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        console.error('备忘录图片渲染失败', { mediaId, error });
        this.renderText('图片不可用');
        this.status = 'ready';
      }
    }
  }

  private renderText(text: string): void {
    const placeholder = document.createElement('span');
    placeholder.className = 'memo-image-placeholder';
    placeholder.textContent = text;
    this.contentNode.replaceChildren(placeholder);
  }

  /** 中止进行中的请求并释放对象地址，重新挂载时可以从占位状态重新加载。 */
  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.status = 'idle';
  }
}

Quill.register('formats/memo_image', MemoImageBlot, true);

/** 卸载时主动释放编辑器内所有图片 blot；DOM 整体删除不会触发各自的 detach。 */
function disposeMemoImages(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.memo-image').forEach((node) => {
    const blot = Quill.find(node) as { dispose?: () => void } | null;
    blot?.dispose?.();
  });
}

/** 只启用与移动端 delta_v1 共用的格式，用户未编辑时保留原始文档。 */
export function MemoEditor({
  initial,
  onChange,
  onInvalid,
  disabled,
}: {
  initial: MemoDelta;
  onChange: (value: MemoDelta) => void;
  onInvalid: (value: boolean) => void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Quill | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [editingError, setEditingError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const callbacks = useRef({ onChange, onInvalid });
  useEffect(() => {
    callbacks.current = { onChange, onInvalid };
  }, [onChange, onInvalid]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const container = document.createElement('div');
    element.append(container);
    /** 标题换行作为一次完整编辑提交，保留前半行标题并让后半行使用正文样式。 */
    function insertHeaderBreak(quill: Quill, range: Range): boolean {
      try {
        const [firstLine] = quill.getLine(range.index);
        const formats = firstLine?.formats();
        if (!formats?.header) return false;
        const [lastLine, endOffset] = quill.getLine(range.index + range.length);
        if (!lastLine) return false;
        // 行格式附着在段末换行符上；选区跨行时，应清理选区末尾剩余段落的换行符。
        const change = new Delta()
          .retain(range.index)
          .delete(range.length)
          .insert('\n', formats)
          .retain(lastLine.length() - endOffset - 1)
          .retain(1, { header: null });
        quill.history.cutoff();
        quill.updateContents(change, 'user');
        quill.history.cutoff();
        quill.setSelection(range.index + 1, 'silent');
        quill.scrollSelectionIntoView();
        setEditingError(false);
        return true;
      } catch (error) {
        console.error('备忘录标题换行失败', { index: range.index, length: range.length, error });
        setEditingError(true);
        return true;
      }
    }
    const quill = new Quill(container, {
      theme: 'snow',
      placeholder: '把此刻的想法记录下来…',
      formats: ['bold', 'header', 'list', 'indent', 'memo_image'],
      modules: {
        keyboard: {
          bindings: {
            'header enter': false,
            memoHeaderEnter: {
              key: 'Enter',
              shiftKey: null,
              /** 按选区起始行判断标题，让行中和跨段选区使用相同的换行语义。 */
              handler(this: { quill: Quill }, range: Range) {
                return !insertHeaderBreak(this.quill, range);
              },
            },
          },
        },
        toolbar: [
          ['bold'],
          [{ header: [1, 2, 3, false] }],
          [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
          [{ indent: '-1' }, { indent: '+1' }],
          ['clean'],
        ],
      },
    });
    editor.current = quill;
    const labels: Record<string, string> = {
      'ql-bold': '加粗',
      'ql-list:ordered': '编号列表',
      'ql-list:bullet': '项目列表',
      'ql-list:check': '待办清单',
      'ql-indent:-1': '减少缩进',
      'ql-indent:+1': '增加缩进',
      'ql-clean': '清除格式',
    };
    element.querySelectorAll<HTMLButtonElement>('.ql-toolbar button').forEach((button) => {
      const name = button.className.split(' ').find((value) => value.startsWith('ql-')) ?? '';
      const label = labels[`${name}:${button.value}`] ?? labels[name] ?? '文本格式';
      button.setAttribute('aria-label', label);
      button.title = label;
    });
    element.querySelectorAll<HTMLElement>('.ql-header .ql-picker-item').forEach((item) => {
      item.dataset.label = item.dataset.value ? `标题 ${item.dataset.value}` : '正文';
      item.setAttribute('aria-label', item.dataset.label);
    });
    const pickerLabel = element.querySelector<HTMLElement>('.ql-header .ql-picker-label');
    if (pickerLabel) {
      pickerLabel.dataset.label = '正文';
      pickerLabel.setAttribute('aria-label', '段落样式');
    }
    quill.root.setAttribute('role', 'textbox');
    quill.root.setAttribute('aria-label', '备忘录正文');
    quill.root.setAttribute('aria-multiline', 'true');
    quill.setContents(new Delta(initial.ops), 'silent');
    /** 虚拟键盘没有 keydown 时，仍将原生段落换行交给同一条标题拆分规则。 */
    function beforeInput(event: InputEvent) {
      try {
        if (
          event.defaultPrevented ||
          event.isComposing ||
          !event.cancelable ||
          !quill.isEnabled() ||
          !['insertParagraph', 'insertLineBreak'].includes(event.inputType)
        ) {
          return;
        }
        const range = quill.getSelection();
        if (range && insertHeaderBreak(quill, range)) event.preventDefault();
      } catch (error) {
        console.error('备忘录原生换行失败', { inputType: event.inputType, error });
        setEditingError(true);
        event.preventDefault();
      }
    }
    const changed = (_delta: unknown, _old: unknown, source: string) => {
      if (source !== 'user') return;
      const parsed = deltaSchema.safeParse({ ops: quill.getContents().ops });
      callbacks.current.onInvalid(!parsed.success);
      if (parsed.success) callbacks.current.onChange(parsed.data);
    };
    quill.on('text-change', changed);
    quill.root.addEventListener('beforeinput', beforeInput);
    return () => {
      quill.off('text-change', changed);
      quill.root.removeEventListener('beforeinput', beforeInput);
      disposeMemoImages(quill.root);
      editor.current = null;
      element.replaceChildren();
    };
  }, [initial]);
  useEffect(() => {
    editor.current?.enable(!disabled);
  }, [disabled]);
  /** 图片独占一段：插入点前后不是换行时补换行，光标落在图片下一段开头。 */
  function insertImage(mediaId: string): void {
    const quill = editor.current;
    if (!quill || !quill.isEnabled()) return;
    const range = quill.getSelection(true) ?? { index: Math.max(0, quill.getLength() - 1), length: 0 };
    const index = Math.min(range.index, quill.getLength() - 1);
    if (range.length) quill.deleteText(index, range.length, 'user');
    const text = quill.getText();
    const before = index > 0 ? text[index - 1] : '\n';
    const after = index < text.length - 1 ? text[index] : '\n';
    let position = index;
    if (before !== '\n') {
      quill.insertText(position, '\n', 'user');
      position++;
    }
    quill.insertEmbed(position, 'memo_image', mediaId, 'user');
    if (after !== '\n') quill.insertText(position + 1, '\n', 'user');
    quill.setSelection(position + 2, 'silent');
  }
  /** 选图后先在本地压缩上传，成功才写入正文，失败保留编辑内容并提示重试。 */
  async function chooseImage(file: File): Promise<void> {
    setUploadError(false);
    setUploading(true);
    try {
      const mediaId = await uploadMemoImage(file);
      if (!alive.current) return;
      insertImage(mediaId);
    } catch (error) {
      logMemoError('插入备忘录图片失败', error);
      if (alive.current) setUploadError(true);
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  return (
    <>
      {!disabled && (
        <div className="memo-image-toolbar">
          <Button variant="secondary" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
            <ImagePlus size={16} />
            {uploading ? '正在上传图片…' : '插入图片'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 清空选择值，连续选择同一张图片时仍会触发 change。
              event.target.value = '';
              if (file) void chooseImage(file);
            }}
          />
          {uploadError && (
            <p className="error-text" role="alert">
              插入图片失败，请稍后重试
            </p>
          )}
        </div>
      )}
      <div className="memo-editor" ref={host} />
      {editingError && (
        <p className="error-text" role="alert">
          换行暂时失败，请重试。
        </p>
      )}
    </>
  );
}
