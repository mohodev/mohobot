import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { AlertCircle, LoaderCircle } from 'lucide-react';

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

export function Panel({ title, description, action, children, className = '' }: PropsWithChildren<{
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={`panel ${className}`}>
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

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="empty-state"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

export function StatCard({ label, value, note, icon }: { label: string; value: ReactNode; note?: string; icon?: ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function Table({ children }: PropsWithChildren) {
  return <div className="table-scroll"><table className="data-table">{children}</table></div>;
}
