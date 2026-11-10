import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ReactElement,
} from 'react';
import { AlertCircle, Inbox, LoaderCircle, X } from 'lucide-react';
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  headingLevel = 1,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <Heading>{title}</Heading>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Avatar({
  name,
  color,
  size = 'md',
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md' | 'lg' | number;
}) {
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{
        background: color,
        ...(typeof size === 'number' ? { width: size, height: size } : {}),
      }}
      aria-hidden="true"
    >
      {name
        .replace(/^Dr\.?\s+/i, '')
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
        .map((x) => x[0])
        .join('')}
    </span>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Inbox size={25} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={21} className="spin" /> Loading your workspace…
    </div>
  );
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <strong>We couldn’t load this.</strong>
        <p>{message}</p>
        {retry && (
          <button className="button button-secondary button-small" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const generatedId = useId();
  const isControl =
    isValidElement(children) &&
    typeof children.type === 'string' &&
    ['input', 'select', 'textarea'].includes(children.type);
  const control = children as ReactElement<{ id?: string; 'aria-describedby'?: string }>;
  const id = isControl && control.props.id ? control.props.id : generatedId;
  return (
    <div className="field">
      <label className="field-label" id={`${id}-label`} htmlFor={isControl ? id : undefined}>
        {label}
      </label>
      {isControl ? (
        cloneElement(control, {
          id,
          'aria-describedby':
            [control.props['aria-describedby'], hint ? `${id}-hint` : null]
              .filter(Boolean)
              .join(' ') || undefined,
        })
      ) : (
        <div role="group" aria-labelledby={`${id}-label`}>
          {children}
        </div>
      )}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex="0"]',
        ) ?? [],
      ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const items = focusables();
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = before;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
