// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaxonomyDelete, TaxonomyEditor, TaxonomyManager } from './taxonomy-dialogs';
import {
  availableTaxonomies,
  taxonomyContentError,
  taxonomyFormSchema,
  taxonomyName,
  taxonomyReplacementError,
} from './taxonomy-data';
import type { TaxonomyKind, TaxonomyRow } from './taxonomy-data';
import { ExerciseFields } from './exercise-fields';
import { TemplateFields } from './template-fields';
import { FitnessEditor } from './editor';
import { newContent } from './model';
import type { ExerciseContent, FitnessRow, TemplateContent } from './model';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  saveFitness: vi.fn(),
  invalidateQueries: vi.fn(),
  query: vi.fn(),
  permissions: ['fitness:read', 'fitness:write'],
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.query }));
vi.mock('../../api/client', () => ({
  api: { adminFitnessTaxonomies: mocks },
  InputError: class extends Error {},
  request: (operation: () => unknown) => operation(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : '目录读取失败'),
}));
vi.mock('../../auth/session', () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
  useSession: () => ({ session: { admin: { permissions: mocks.permissions } } }),
}));
vi.mock('./data', () => ({ saveFitness: mocks.saveFitness }));

/** 使用服务端目录样例，分类身份无需属于预置枚举。 */
function category(id: string, kind: TaxonomyKind, changes: Partial<TaxonomyRow> = {}): TaxonomyRow {
  return {
    id,
    kind,
    name: { zh: `分类${id}`, zh_hant: `分類${id}`, en: `Category ${id}` },
    sort_order: 1,
    version: 2,
    is_deleted: false,
    exercise_count: 0,
    template_count: 0,
    ...changes,
  };
}
const body = category('new-body', 'body_part');
const equipment = category('new-equipment', 'equipment');
const onClose = vi.fn();
const onSaved = vi.fn();
let root: Root;
let container: HTMLDivElement;

/** 挂载真实弹窗以校验交互与权限边界。 */
async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

/** 根据可见标签寻找受控字段。 */
function field(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return Array.from(document.querySelectorAll('label'))
    .find((item) => item.textContent?.startsWith(label))!
    .querySelector('input,select,textarea')!;
}

/** 通过原生事件更新输入，避免直接改动组件内部状态。 */
async function fill(label: string, value: string): Promise<void> {
  await act(async () => {
    const input = field(label);
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 点击用户可见操作按钮。 */
async function click(text: string): Promise<void> {
  await act(async () => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === text);
    expect(button).toBeDefined();
    button!.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.permissions = ['fitness:read', 'fitness:write'];
  mocks.query.mockImplementation(({ queryKey }: { queryKey: string[] }) => ({
    data: { items: queryKey[3] === 'body_part' ? [body] : [equipment] },
    isPending: false,
    isError: false,
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('动态部位和器械目录', () => {
  it('同类型未删除目录才可被选择，历史名称使用当前目录多语言值', () => {
    const deleted = category('removed', 'body_part', { is_deleted: true });
    expect(availableTaxonomies([body, equipment, deleted], 'body_part')).toEqual([body]);
    expect(taxonomyName([body], body.id, 'en')).toBe('Category new-body');
    expect(taxonomyName([deleted], deleted.id)).toContain('已删除');
    expect(taxonomyName([], 'private-id')).toBe('分类资料暂不可用');
    expect(taxonomyFormSchema.safeParse({ name: body.name, sort_order: 9999 }).success).toBe(true);
    expect(taxonomyFormSchema.safeParse({ name: { ...body.name, zh: ' ' }, sort_order: 0 }).success).toBe(false);
    expect(taxonomyFormSchema.safeParse({ name: body.name, sort_order: 10000 }).success).toBe(false);
  });

  it('保存内容拒绝已删目录，有引用删除必须替换为同类型有效分类', () => {
    const exercise = { ...newContent('exercise'), body_part: body.id, equipment: equipment.id } as ExerciseContent;
    expect(taxonomyContentError('exercise', exercise, [body], [equipment])).toBeNull();
    expect(taxonomyContentError('exercise', exercise, [{ ...body, is_deleted: true }], [equipment])).toContain('部位');
    const referenced = { ...body, exercise_count: 1 };
    expect(taxonomyReplacementError(referenced, '', [body, equipment])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, equipment.id, [body, equipment])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, body.id, [body])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, 'other', [category('other', 'body_part')])).toBeNull();
    expect(taxonomyReplacementError(body, '', [body])).toBeNull();
  });

  it('只读管理页可查看名称和引用数，隐藏新增修改删除且不展示软删项', async () => {
    mocks.permissions = ['fitness:read'];
    mocks.query.mockReturnValue({
      data: { items: [{ ...body, exercise_count: 7 }, category('removed', 'body_part', { is_deleted: true })] },
      isPending: false,
      isError: false,
    });
    await render(createElement(TaxonomyManager, { kind: 'body_part', onClose }));
    expect(document.body.textContent).toContain(body.name.zh);
    expect(document.body.textContent).toContain('动作引用');
    expect(document.body.textContent).not.toContain('分类removed');
    for (const text of ['新增部位', '修改', '删除']) {
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === text)).toBe(false);
    }
  });

  it('新增和修改同时发送三语名称、排序、原因，修改保留版本', async () => {
    await render(createElement(TaxonomyEditor, { kind: 'body_part', onClose, onSaved }));
    await fill('简体中文名称', '核心');
    await fill('繁体中文名称', '核心');
    await fill('英文名称', 'Core');
    await fill('排序', '3');
    await fill('操作原因', '补充训练分类');
    await click('保存部位');
    expect(mocks.create).toHaveBeenCalledWith('body_part', {
      name: { zh: '核心', zh_hant: '核心', en: 'Core' },
      sort_order: 3,
      reason: '补充训练分类',
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'fitness'] });
    await render(createElement(TaxonomyEditor, { key: 'edit', kind: 'body_part', current: body, onClose, onSaved }));
    await fill('简体中文名称', '核心部位');
    await fill('操作原因', '修正名称');
    await click('保存部位');
    expect(mocks.update).toHaveBeenCalledWith('body_part', body.id, {
      name: { ...body.name, zh: '核心部位' },
      sort_order: 1,
      version: 2,
      reason: '修正名称',
    });
  });

  it('有引用删除明确迁移影响，不能空替换提交且选项排除自己和软删项', async () => {
    const replacement = category('replacement', 'body_part');
    await render(
      createElement(TaxonomyDelete, {
        row: { ...body, exercise_count: 2, template_count: 1 },
        rows: [body, replacement, category('deleted', 'body_part', { is_deleted: true }), equipment],
        onClose,
        onSaved,
      }),
    );
    expect(document.body.textContent).toContain('2 个动作 · 1 个模板正在引用');
    expect(document.body.textContent).toContain('动作、模板和历史训练记录保留');
    expect(Array.from((field('替代部位') as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      '',
      replacement.id,
    ]);
    await fill('操作原因', '合并重复分类');
    await click('确认删除');
    expect(mocks.delete).not.toHaveBeenCalled();
    await fill('替代部位', replacement.id);
    await click('确认删除');
    expect(mocks.delete).toHaveBeenCalledWith('body_part', body.id, {
      version: 2,
      replacement_id: replacement.id,
      reason: '合并重复分类',
    });
  });

  it('未引用分类可直接删除，有引用却无替代项时不能提交', async () => {
    await render(createElement(TaxonomyDelete, { row: body, rows: [body], onClose, onSaved }));
    await fill('操作原因', '清理未使用分类');
    await click('确认删除');
    expect(mocks.delete).toHaveBeenCalledWith('body_part', body.id, {
      version: 2,
      replacement_id: undefined,
      reason: '清理未使用分类',
    });
    await render(
      createElement(TaxonomyDelete, {
        key: 'referenced',
        row: { ...body, exercise_count: 1 },
        rows: [body],
        onClose,
        onSaved,
      }),
    );
    expect(document.body.textContent).toContain('请先新增同类型分类');
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === '确认删除');
    expect(button!.disabled).toBe(true);
  });

  it('动作和模板编辑选项取服务端目录，新建内容不写死任何可删除分类', async () => {
    const content = newContent('exercise') as ExerciseContent;
    expect(content.body_part).toBe('');
    expect(content.equipment).toBe('');
    await render(
      createElement(ExerciseFields, {
        value: content,
        onChange: vi.fn(),
        onUploading: vi.fn(),
        bodyParts: [body],
        equipment: [equipment],
      }),
    );
    expect(Array.from((field('部位') as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      '',
      body.id,
    ]);
    expect(Array.from((field('器械') as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      '',
      equipment.id,
    ]);
    await render(
      createElement(TemplateFields, {
        value: newContent('template') as TemplateContent,
        onChange: vi.fn(),
        equipment: [equipment],
      }),
    );
    expect(document.body.textContent).toContain(equipment.name.zh);
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it('编辑器拒绝保存已被删除的分类，目录读取失败也不能写入', async () => {
    const content: ExerciseContent = {
      ...(newContent('exercise') as ExerciseContent),
      body_part: 'removed',
      equipment: equipment.id,
      name_zh: '动作',
      name_zh_hant: '動作',
      name_en: 'Exercise',
      target: '肌群',
      instructions_zh: ['说明'],
      instructions_zh_hant: ['說明'],
      instructions_en: ['Step'],
    };
    const current: FitnessRow = {
      id: 'exercise-1',
      kind: 'exercise',
      version: 1,
      content,
      is_enabled: true,
      created_at: '',
      updated_at: '',
      updated_by: null,
    };
    await render(createElement(FitnessEditor, { kind: 'exercise', current, onClose, onSaved: async () => undefined }));
    await act(async () =>
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(document.body.textContent).toContain('请选择当前可用的部位');
    expect(mocks.saveFitness).not.toHaveBeenCalled();
    mocks.query.mockReturnValue({ isPending: false, isError: true, error: new Error('目录读取失败') });
    await render(createElement(FitnessEditor, { kind: 'exercise', current, onClose, onSaved: async () => undefined }));
    const save = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '保存');
    expect(save!.disabled).toBe(true);
  });
});
