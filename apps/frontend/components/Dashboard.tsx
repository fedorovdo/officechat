"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { BrandLogo } from "./Brand";
import { AdminCard, AdminIcon, AdminPageShell } from "./AdminUI";
import { getLocalizedBrand } from "../lib/brand";
import { getCurrentUser, getLocalizedApiError, isAdminRole, requireStoredAccessToken } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { logoutSession } from "../lib/session";

type DashboardProps = {
  dictionary: Dictionary;
  locale: Locale;
};

type CurrentUser = {
  username: string;
  display_name: string;
  role: string;
};

export function Dashboard({ dictionary, locale }: DashboardProps) {
  const localizedBrand = getLocalizedBrand(locale);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const accessToken = token;

    async function loadUser() {
      try {
        setUser((await getCurrentUser(accessToken)) as CurrentUser);
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
      }
    }

    void loadUser();
  }, [dictionary.dashboard.loadError, locale]);

  async function logout() {
    await logoutSession(locale);
  }

  return (
    <AdminPageShell ariaLabel={dictionary.dashboard.ariaLabel} className="admin-dashboard" wide>
      <section className="admin-dashboard-hero">
        <div className="admin-dashboard-brand">
            <BrandLogo tagline={localizedBrand.tagline} />
          <div><h1>{dictionary.dashboard.title}</h1><p>{dictionary.adminUi.dashboardSubtitle}</p></div>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {!user && !error ? <p className="muted">{dictionary.dashboard.loading}</p> : null}
        {user ? (
          <div className="admin-account-summary">
            <div className="admin-account-identity">
              <span>{dictionary.adminUi.account}</span>
              <strong>{user.display_name}</strong>
              <small>@{user.username}</small>
              <span className="admin-badge admin-badge-info">{user.role}</span>
            </div>
            <div className="admin-account-actions">
              <Link className="admin-button admin-button-primary" href={`/${locale}/app`}>{dictionary.dashboard.openApp}</Link>
              <button className="admin-button admin-button-secondary" onClick={logout} type="button">{dictionary.dashboard.logout}</button>
            </div>
          </div>
        ) : null}
      </section>

      {user ? <section aria-labelledby="admin-sections-title" className="admin-dashboard-section">
        <h2 id="admin-sections-title">{dictionary.adminUi.sectionsTitle}</h2>
        <div className="admin-action-grid">
          <Link className="admin-action-card" href={`/${locale}/groups`}><span className="admin-action-icon"><AdminIcon name="groups" /></span><span><strong>{dictionary.dashboard.groups}</strong><small>{dictionary.adminUi.sectionDescriptions.groups}</small></span><span className="admin-action-open">{dictionary.adminUi.open}</span></Link>
          {isAdminRole(user.role) ? <>
            <Link className="admin-action-card" href={`/${locale}/admin/users`}><span className="admin-action-icon"><AdminIcon name="users" /></span><span><strong>{dictionary.dashboard.adminUsers}</strong><small>{dictionary.adminUi.sectionDescriptions.users}</small></span><span className="admin-action-open">{dictionary.adminUi.open}</span></Link>
            <Link className="admin-action-card" href={`/${locale}/admin/bots`}><span className="admin-action-icon"><AdminIcon name="bots" /></span><span><strong>{dictionary.dashboard.adminBots}</strong><small>{dictionary.adminUi.sectionDescriptions.bots}</small></span><span className="admin-action-open">{dictionary.adminUi.open}</span></Link>
            <Link className="admin-action-card" href={`/${locale}/admin/storage`}><span className="admin-action-icon"><AdminIcon name="storage" /></span><span><strong>{dictionary.retention.title}</strong><small>{dictionary.adminUi.sectionDescriptions.storage}</small></span><span className="admin-action-open">{dictionary.adminUi.open}</span></Link>
            <Link className="admin-action-card" href={`/${locale}/admin/audit`}><span className="admin-action-icon"><AdminIcon name="audit" /></span><span><strong>{dictionary.audit.title}</strong><small>{dictionary.adminUi.sectionDescriptions.audit}</small></span><span className="admin-action-open">{dictionary.adminUi.open}</span></Link>
          </> : null}
        </div>
      </section> : null}

      <AdminCard className="admin-additional-card" title={dictionary.adminUi.additionalTitle}>
        <Link className="admin-secondary-card-link" href={`/${locale}/about`}><AdminIcon name="about" /><span><strong>{dictionary.dashboard.about}</strong><small>{dictionary.adminUi.sectionDescriptions.about}</small></span></Link>
      </AdminCard>
    </AdminPageShell>
  );
}
