import { useEffect, useRef, useState } from 'react';
import Quill, { Delta, type Range } from 'quill';
import 'quill/dist/quill.snow.css';
import './memo-editor.css';
import { deltaSchema, type MemoDelta } from './memo-content';

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
  const [editingError, setEditingError] = useState(false);
  const callbacks = useRef({ onChange, onInvalid });
  useEffect(() => {
    callbacks.current = { onChange, onInvalid };
  }, [onChange, onInvalid]);
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
      formats: ['bold', 'header', 'list', 'indent'],
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
      editor.current = null;
      element.replaceChildren();
    };
  }, [initial]);
  useEffect(() => {
    editor.current?.enable(!disabled);
  }, [disabled]);
  return (
    <>
      <div className="memo-editor" ref={host} />
      {editingError && (
        <p className="error-text" role="alert">
          换行暂时失败，请重试。
        </p>
      )}
    </>
  );
}
