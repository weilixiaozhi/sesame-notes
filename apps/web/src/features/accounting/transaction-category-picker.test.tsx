import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import { TransactionCategoryPicker } from './transaction-category-picker';

type Category = components['schemas']['Category'];

/** 构造分类目录中的真实层级字段，使测试只关注用户选择行为。 */
function category(id: string, name: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    name,
    kind: 'expense',
    level: 1,
    parent_id: null,
    icon: 'utensils',
    sort_order: 0,
    deleted_at: null,
    version_token: 'test-category-version',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const food = category('food', '餐饮');
const breakfast = category('breakfast', '早餐', { level: 2, parent_id: food.id });
const travel = category('travel', '交通');
const categories = [food, breakfast, travel];

/** 用受控表单承接选择结果，验证点击后实际呈现的选中和展开状态。 */
function PickerForm({
  items = categories,
  initialValue = '',
  disabled = false,
  onChange = () => {},
  onBlur = () => {},
}: {
  items?: Category[];
  initialValue?: string;
  disabled?: boolean;
  onChange?: (id: string) => void;
  onBlur?: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  /** 表单仅在分类回调成功后更新值，失败时保留已有选择供用户重试。 */
  function change(id: string) {
    onChange(id);
    setValue(id);
  }

  return (
    <TransactionCategoryPicker
      categories={items}
      value={value}
      onChange={change}
      onBlur={onBlur}
      triggerRef={null}
      disabled={disabled}
    />
  );
}

describe('记账分类触摸选择', () => {
  it('点击父分类立即选中并在所在五列行下方展示子分类', () => {
    const second = category('shopping', '购物');
    const third = category('home', '居家');
    const fourth = category('health', '医疗');
    const fifth = category('study', '学习');
    const sixth = category('leisure', '娱乐');
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(
      <PickerForm items={[food, breakfast, second, third, fourth, fifth, sixth]} onChange={onChange} onBlur={onBlur} />,
    );

    const parent = screen.getByRole('button', { name: '选择分类 餐饮' });
    fireEvent.click(parent);

    expect(parent.getAttribute('aria-pressed')).toBe('true');
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('已选：餐饮');
    expect(onChange).toHaveBeenLastCalledWith(food.id);
    expect(onBlur).toHaveBeenCalledTimes(1);
    const children = screen.getByRole('group', { name: '餐饮的子分类' });
    expect(within(children).getByRole('button', { name: '选择分类 餐饮 / 早餐' })).toBeTruthy();
    // 子项排在父分类所在行之后、下一行之前，用户无需跳到列表底部寻找子项。
    const rowEnd = screen.getByRole('button', { name: '选择分类 学习' });
    const nextRow = screen.getByRole('button', { name: '选择分类 娱乐' });
    expect(rowEnd.compareDocumentPosition(children) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(children.compareDocumentPosition(nextRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('重复点击含子项的父分类保持展开，父分类仍可作为有效选择', () => {
    render(<PickerForm initialValue={food.id} />);
    const parent = screen.getByRole('button', { name: '选择分类 餐饮' });

    fireEvent.click(parent);
    fireEvent.click(parent);

    expect(parent.getAttribute('aria-pressed')).toBe('true');
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: '餐饮的子分类' })).toBeTruthy();
  });

  it('选择子分类保留父级展开，切换无子项的分类后收起子区域', () => {
    const onChange = vi.fn();
    render(<PickerForm initialValue={food.id} onChange={onChange} />);

    const parent = screen.getByRole('button', { name: '选择分类 餐饮' });
    const child = screen.getByRole('button', { name: '选择分类 餐饮 / 早餐' });
    fireEvent.click(child);

    expect(onChange).toHaveBeenLastCalledWith(breakfast.id);
    expect(child.getAttribute('aria-pressed')).toBe('true');
    expect(parent.getAttribute('aria-pressed')).toBe('false');
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('已选：餐饮 / 早餐');

    fireEvent.click(screen.getByRole('button', { name: '选择分类 交通' }));

    expect(onChange).toHaveBeenLastCalledWith(travel.id);
    expect(screen.getByRole('button', { name: '选择分类 交通' }).getAttribute('aria-pressed')).toBe('true');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: '餐饮的子分类' })).toBeNull();
  });

  it('编辑已有子分类时首屏直接显示选中项及其父级区域', () => {
    render(<PickerForm initialValue={breakfast.id} />);

    expect(screen.getByRole('button', { name: '选择分类 餐饮' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '选择分类 餐饮 / 早餐' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('已选：餐饮 / 早餐');
  });

  it('过滤已删除项，仍允许选择父级缺失或已删除的有效子分类', () => {
    const removed = category('removed', '已删除父分类', { deleted_at: '2026-10-02T00:00:00.000Z' });
    const removedChild = category('removed-child', '已删除子分类', {
      level: 2,
      parent_id: food.id,
      deleted_at: '2026-10-02T00:00:00.000Z',
    });
    const missingParentChild = category('orphan', '历史分类', { level: 2, parent_id: 'missing' });
    const removedParentChild = category('survivor', '仍可使用', { level: 2, parent_id: removed.id });
    const onChange = vi.fn();
    render(
      <PickerForm
        items={[...categories, removed, removedChild, missingParentChild, removedParentChild]}
        initialValue={food.id}
        onChange={onChange}
      />,
    );

    expect(screen.queryByRole('button', { name: /已删除/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择分类 历史分类' }));
    expect(onChange).toHaveBeenLastCalledWith(missingParentChild.id);
    expect(screen.getByRole('status').textContent).toBe('已选：历史分类');

    fireEvent.click(screen.getByRole('button', { name: '选择分类 仍可使用' }));
    expect(onChange).toHaveBeenLastCalledWith(removedParentChild.id);
    expect(screen.getByRole('status').textContent).toBe('已选：仍可使用');
  });

  it('禁用时父分类和已展开子分类都不能修改表单', () => {
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(<PickerForm initialValue={food.id} disabled onChange={onChange} onBlur={onBlur} />);

    const otherParent = screen.getByRole('button', { name: '选择分类 交通' });
    const child = screen.getByRole('button', { name: '选择分类 餐饮 / 早餐' });
    expect(otherParent.matches(':disabled')).toBe(true);
    expect(child.matches(':disabled')).toBe(true);
    fireEvent.click(otherParent);
    fireEvent.click(child);

    expect(onChange).not.toHaveBeenCalled();
    expect(onBlur).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('已选：餐饮');
  });

  it('选择回调失败时显示可理解的重试提示并记录详细原因，重试成功后清除提示', () => {
    const cause = new Error('表单状态更新失败');
    const onChange = vi.fn().mockImplementationOnce(() => {
      throw cause;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PickerForm initialValue={travel.id} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '选择分类 餐饮' }));

    expect(screen.getByRole('alert').textContent).toMatch(/无法选择分类.*再点一次/);
    expect(screen.getByRole('status').textContent).toBe('已选：交通');
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ categoryId: food.id, cause }));

    fireEvent.click(screen.getByRole('button', { name: '选择分类 餐饮' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('已选：餐饮');
  });

  it('表单校验回调抛错也会报告友好错误和详细日志', () => {
    const cause = new Error('分类校验失败');
    const onBlur = vi.fn(() => {
      throw cause;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PickerForm onBlur={onBlur} />);

    fireEvent.click(screen.getByRole('button', { name: '选择分类 餐饮' }));

    expect(screen.getByRole('alert').textContent).toMatch(/无法选择分类.*再点一次/);
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ categoryId: food.id, cause }));
  });
});
