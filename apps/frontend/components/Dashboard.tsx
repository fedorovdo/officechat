"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { BrandLogo } from "./Brand";
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
    <main className="dashboard">
      <section className="dashboard-shell" aria-label={dictionary.dashboard.ariaLabel}>
        <div className="dashboard-header">
          <div>
            <BrandLogo tagline={localizedBrand.tagline} />
            <h1 className="dashboard-title">{dictionary.dashboard.title}</h1>
          </div>
          <button className="secondary-link" onClick={logout} type="button">
            {dictionary.dashboard.logout}
          </button>
        </div>

        {error ? <p className="form-error">{error}</p> : null}
        {!user && !error ? <p className="muted">{dictionary.dashboard.loading}</p> : null}

        {user ? (
          <div className="user-facts">
            <div className="user-fact">
              <span className="status-label">{dictionary.dashboard.displayName}</span>
              <strong>{user.display_name}</strong>
            </div>
            <div className="user-fact">
              <span className="status-label">{dictionary.dashboard.username}</span>
              <strong>{user.username}</strong>
            </div>
            <div className="user-fact">
              <span className="status-label">{dictionary.dashboard.role}</span>
              <strong>{user.role}</strong>
            </div>
            <Link className="primary-button dashboard-admin-link dashboard-open-app" href={`/${locale}/app`}>
              {dictionary.dashboard.openApp}
            </Link>
            <Link className="secondary-link dashboard-admin-link" href={`/${locale}/about`}>
              {dictionary.dashboard.about}
            </Link>
            <Link className="primary-button dashboard-admin-link" href={`/${locale}/groups`}>
              {dictionary.dashboard.groups}
            </Link>
            {isAdminRole(user.role) ? (
              <>
                <Link className="primary-button dashboard-admin-link" href={`/${locale}/admin/users`}>
                  {dictionary.dashboard.adminUsers}
                </Link>
                <Link className="primary-button dashboard-admin-link" href={`/${locale}/admin/bots`}>
                  {dictionary.dashboard.adminBots}
                </Link>
                <Link className="primary-button dashboard-admin-link" href={`/${locale}/admin/storage`}>
                  {dictionary.retention.title}
                </Link>
                <Link className="primary-button dashboard-admin-link" href={`/${locale}/admin/audit`}>
                  {dictionary.audit.title}
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
