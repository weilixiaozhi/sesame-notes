import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './ui';
import './book-workspace-header.css';

type BookManagementSection = {
  id: string;
  title: string;
  content: ReactNode;
  danger?: boolean;
};

/** 各业务页面共用本子选择与管理布局，具体操作仍由所属页面提供。 */
export function BookWorkspaceHeader({
  label,
  selector,
  actions,
  sections,
  disabled = false,
}: {
  label: string;
  selector: ReactNode;
  actions?: ReactNode;
  sections: readonly BookManagementSection[];
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  /** 展开只改变管理面板的可见性，不触发建本、选本或记录写入。 */
  function toggle() {
    try {
      if (!disabled) setOpen((current) => !current);
    } catch (error) {
      console.error('切换本子管理面板失败', { label, error });
    }
  }

  return (
    <header className="book-workspace-header">
      <div className="book-workspace-toolbar">
        <div className="book-workspace-selector">{selector}</div>
        <div className="book-workspace-actions">
          {actions}
          <Button
            variant="ghost"
            size="sm"
            id={`${id}-trigger`}
            aria-expanded={open}
            aria-controls={id}
            disabled={disabled}
            onClick={toggle}
          >
            {label}
            <ChevronDown size={15} className="book-management-chevron" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        id={id}
        role="region"
        aria-labelledby={`${id}-trigger`}
        hidden={!open}
        className="panel book-management-panel"
      >
        {sections.map((section) => (
          <section
            key={section.id}
            aria-label={section.title}
            className={`book-management-section${section.danger ? ' book-management-danger' : ''}`}
          >
            <h3>{section.title}</h3>
            <div className="book-management-section-content">{section.content}</div>
          </section>
        ))}
      </div>
    </header>
  );
}
