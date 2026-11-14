import type { ButtonHTMLAttributes, InputHTMLAttributes, PropsWithChildren, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { AlertCircle, ChevronDown, LoaderCircle, X } from 'lucide-react';

export function PageTitle({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, description, action, children, className = '', flush }: PropsWithChildren<{
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  flush?: boolean;
}>) {
  return (
    <section className={`panel ${className}${flush ? ' panel-flush' : ''}`}>
      {(title || description || action) && (
        <div className="panel-heading">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, variant = 'secondary', busy, className = '', disabled, ...props }: PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }
>) {
  return (
    <button {...props} className={`button button-${variant} ${className}`.trim()} disabled={disabled || busy}>
      {busy ? <LoaderCircle size={15} className="spin" /> : null}
      {children}
    </button>
  );
}

export function Pill({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }>) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Loading({ label = '正在读取数据' }: { label?: string }) {
  return <div className="state-box"><LoaderCircle className="spin" size={20} /><span>{label}</span></div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="state-box state-error">
      <AlertCircle size={19} />
      <span>{message}</span>
      {retry && <Button onClick={retry}>重试</Button>}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{detail && <span>{detail}</span>}{action}</div>;
}

export function StatCard({ label, value, note, icon, tone }: { label: string; value: ReactNode; note?: string; icon?: ReactNode; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ''}`}>
      <div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function Table({ children, minWidth }: PropsWithChildren<{ minWidth?: number }>) {
  return <div className="table-scroll"><table className="data-table" style={minWidth ? { minWidth } : undefined}>{children}</table></div>;
}

/* ------------------------------------------------------------------ *
 * Additive helpers (shared contract). Pages may rely on these, but    *
 * must not change their signatures.                                   *
 * ------------------------------------------------------------------ */

/** Renders a loading / error / empty / content state machine consistently. */
export function DataState({ loading, error, empty, emptyTitle = '暂无数据', emptyDetail, onRetry, children }: {
  loading?: boolean;
  error?: string;
  empty?: boolean;
  emptyTitle?: string;
  emptyDetail?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={onRetry} />;
  if (empty) return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  return <>{children}</>;
}

/** Inline contextual banner. `tone` maps to the `.notice-*` styles. */
export function Notice({ tone = 'info', icon, children }: PropsWithChildren<{ tone?: 'info' | 'warning' | 'danger'; icon?: ReactNode }>) {
  return <div className={`notice-line notice-${tone}`}>{icon}<span>{children}</span></div>;
}

/** Labeled form control wrapper with optional hint and error text. */
export function Field({ label, hint, error, children }: PropsWithChildren<{ label: string; hint?: string; error?: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`.trim()} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input select ${props.className ?? ''}`.trim()} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`.trim()} />;
}

/** Toggle switch using an accessible checkbox. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <label className={`switch${disabled ? ' switch-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

/** Modal dialog with backdrop, Escape handling and a labelled close button. */
export function Modal({ open, onClose, title, description, children, footer, width }: PropsWithChildren<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  width?: number;
}>) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { maxWidth: width } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Segmented control for switching between mutually exclusive options. */
export function Tabs<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? 'tab tab-active' : 'tab'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="tab-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Compact key/value description list used across detail panels. */
export function Descriptions({ items, columns = 1 }: { items: Array<{ label: string; value: ReactNode }>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`descriptions descriptions-${columns}`}>
      {items.map((item, index) => (
        <div className="description-item" key={`${item.label}:${index}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsible section with a summary header. */
export function Collapsible({ title, defaultOpen = false, children, meta }: PropsWithChildren<{ title: string; defaultOpen?: boolean; meta?: ReactNode }>) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary><ChevronDown size={15} className="collapsible-chevron" /><span>{title}</span>{meta}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

/** Copy-to-clipboard button with transient confirmation. */
export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => { void navigator.clipboard?.writeText(value); }}
      title={`${label}: ${value}`}
    >
      {label}
    </button>
  );
}
