"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    const token = localStorage.getItem("officechat.access_token");
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    async function loadUser() {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (!response.ok) {
          localStorage.removeItem("officechat.access_token");
          router.replace(`/${locale}/login`);
          return;
        }

        setUser((await response.json()) as CurrentUser);
      } catch {
        setError(dictionary.dashboard.loadError);
      }
    }

    void loadUser();
  }, [dictionary.dashboard.loadError, locale, router]);

  async function logout() {
    const token = localStorage.getItem("officechat.access_token");
    if (token) {
      await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }).catch(() => undefined);
    }

    localStorage.removeItem("officechat.access_token");
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
          </div>
        ) : null}
      </section>
    </main>
  );
}
