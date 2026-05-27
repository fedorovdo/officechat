"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { clearStoredAccessToken, getCurrentUser, getStoredAccessToken, isAdminRole } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

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
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;

    async function loadUser() {
      try {
        setUser((await getCurrentUser(accessToken)) as CurrentUser);
      } catch {
        clearStoredAccessToken();
        router.replace(`/${locale}/login`);
      }
    }

    void loadUser();
  }, [locale, router]);

  async function logout() {
    const token = getStoredAccessToken();
    if (token) {
      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }).catch(() => undefined);
    }

    clearStoredAccessToken();
    router.replace(`/${locale}/login`);
  }

  return (
    <main className="dashboard">
      <section className="dashboard-shell" aria-label={dictionary.dashboard.ariaLabel}>
        <div className="dashboard-header">
          <div>
            <p className="eyebrow">{dictionary.app.name}</p>
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
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
