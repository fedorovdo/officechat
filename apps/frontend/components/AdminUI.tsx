import Link from "next/link";
import type { ReactNode } from "react";

type AdminIconName = "about" | "audit" | "back" | "bots" | "download" | "groups" | "storage" | "users";

const iconPaths: Record<AdminIconName, ReactNode> = {
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  audit: <><path d="M9 5h6M9 9h6M9 13h4" /><path d="M7 3h10a2 2 0 0 1 2 2v14H5V5a2 2 0 0 1 2-2Z" /></>,
  back: <><path d="m15 18-6-6 6-6" /><path d="M9 12h10" /></>,
  bots: <><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 3v4M8.5 12h.01M15.5 12h.01M9 15h6" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
  groups: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3 19c0-3 2.5-5 6-5s6 2 6 5M15 15c3 0 5 1.5 5 4" /></>,
  storage: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
  users: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.4-7 8-7s8 3 8 7" /></>
};

export function AdminIcon({ name }: { name: AdminIconName }) {
  return <svg aria-hidden="true" className="admin-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{iconPaths[name]}</svg>;
}

export function AdminPageShell({ ariaLabel, children, className = "", wide = false }: { ariaLabel: string; children: ReactNode; className?: string; wide?: boolean }) {
  return <main className={`admin-ui-page ${className}`.trim()}><section aria-label={ariaLabel} className={`admin-ui-shell ${wide ? "admin-ui-shell-wide" : ""}`.trim()}>{children}</section></main>;
}

export function AdminBackLink({ href, label }: { href: string; label: string }) {
  return <Link className="admin-back-link" href={href}><AdminIcon name="back" /><span>{label}</span></Link>;
}

export function AdminPageHeader({ actions, backHref, backLabel, description, meta, title }: { actions?: ReactNode; backHref: string; backLabel: string; description?: string; meta?: ReactNode; title: string }) {
  return (
    <header className="admin-page-header">
      <AdminBackLink href={backHref} label={backLabel} />
      <div className="admin-page-heading-row">
        <div className="admin-page-heading"><h1>{title}</h1>{description ? <p>{description}</p> : null}{meta ? <div className="admin-page-meta">{meta}</div> : null}</div>
        {actions ? <div className="admin-page-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function AdminCard({ children, className = "", description, title }: { children: ReactNode; className?: string; description?: string; title?: string }) {
  return <section className={`admin-card ${className}`.trim()}>{title ? <div className="admin-card-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}{children}</section>;
}

export function AdminStatCard({ label, value }: { label: string; value: string }) {
  return <article className="admin-stat-card"><span>{label}</span><strong>{value}</strong></article>;
}

export function AdminTableContainer({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`admin-table-container ${className}`.trim()}>{children}</div>;
}
