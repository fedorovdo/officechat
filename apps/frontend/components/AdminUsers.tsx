"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  clearStoredAccessToken,
  createAdminUser,
  getAdminUsers,
  getCurrentUser,
  getStoredAccessToken,
  isAdminRole,
  type CreateAdminUserPayload,
  type OfficeChatUser,
  type UserRole
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminUsersProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const roles: UserRole[] = ["superadmin", "admin", "group_owner", "moderator", "user", "bot"];

const initialForm: CreateAdminUserPayload = {
  username: "",
  display_name: "",
  email: "",
  password: "",
  role: "user",
  is_active: true
};

export function AdminUsers({ dictionary, locale }: AdminUsersProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [users, setUsers] = useState<OfficeChatUser[]>([]);
  const [form, setForm] = useState<CreateAdminUserPayload>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short"
      }),
    [locale]
  );

  async function reloadUsers(token: string) {
    const loadedUsers = await getAdminUsers(token);
    setUsers(loadedUsers);
  }

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;

    async function loadPage() {
      try {
        const user = await getCurrentUser(accessToken);
        setCurrentUser(user);

        if (!isAdminRole(user.role)) {
          setAccessDenied(true);
          return;
        }

        await reloadUsers(accessToken);
      } catch {
        clearStoredAccessToken();
        router.replace(`/${locale}/login`);
      } finally {
        setIsLoading(false);
      }
    }

    void loadPage();
  }, [locale, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setIsSubmitting(true);
    try {
      await createAdminUser(token, {
        ...form,
        email: form.email?.trim() ? form.email.trim() : null,
        username: form.username.trim(),
        display_name: form.display_name.trim()
      });
      setForm(initialForm);
      await reloadUsers(token);
      setSuccess(dictionary.adminUsers.createSuccess);
    } catch (caughtError) {
      setForm((currentForm) => ({ ...currentForm, password: "" }));
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminUsers.createError);
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateForm<Key extends keyof CreateAdminUserPayload>(
    key: Key,
    value: CreateAdminUserPayload[Key]
  ) {
    setForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  return (
    <main className="admin-page">
      <section className="admin-shell" aria-label={dictionary.adminUsers.ariaLabel}>
        <div className="dashboard-header">
          <div>
            <Link className="locale-link" href={`/${locale}/dashboard`}>
              {dictionary.adminUsers.backToDashboard}
            </Link>
            <h1 className="dashboard-title admin-title">{dictionary.adminUsers.title}</h1>
            {currentUser ? (
              <p className="admin-current">
                {currentUser.display_name} · {currentUser.username} · {currentUser.role}
              </p>
            ) : null}
          </div>
        </div>

        {isLoading ? <p className="muted">{dictionary.adminUsers.loading}</p> : null}
        {accessDenied ? <p className="access-denied">{dictionary.adminUsers.accessDenied}</p> : null}

        {!isLoading && !accessDenied ? (
          <div className="admin-grid">
            <form className="admin-form" onSubmit={handleSubmit}>
              <h2 className="section-title">{dictionary.adminUsers.createTitle}</h2>

              <label className="field">
                <span className="field-label">{dictionary.adminUsers.fields.username}</span>
                <input
                  className="field-input"
                  onChange={(event) => updateForm("username", event.target.value)}
                  required
                  type="text"
                  value={form.username}
                />
              </label>

              <label className="field">
                <span className="field-label">{dictionary.adminUsers.fields.displayName}</span>
                <input
                  className="field-input"
                  onChange={(event) => updateForm("display_name", event.target.value)}
                  required
                  type="text"
                  value={form.display_name}
                />
              </label>

              <label className="field">
                <span className="field-label">{dictionary.adminUsers.fields.email}</span>
                <input
                  className="field-input"
                  onChange={(event) => updateForm("email", event.target.value)}
                  type="email"
                  value={form.email ?? ""}
                />
              </label>

              <label className="field">
                <span className="field-label">{dictionary.adminUsers.fields.password}</span>
                <input
                  autoComplete="new-password"
                  className="field-input"
                  minLength={8}
                  onChange={(event) => updateForm("password", event.target.value)}
                  required
                  type="password"
                  value={form.password}
                />
              </label>

              <label className="field">
                <span className="field-label">{dictionary.adminUsers.fields.role}</span>
                <select
                  className="field-input"
                  onChange={(event) => updateForm("role", event.target.value as UserRole)}
                  value={form.role}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {dictionary.adminUsers.roles[role]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="checkbox-field">
                <input
                  checked={form.is_active}
                  onChange={(event) => updateForm("is_active", event.target.checked)}
                  type="checkbox"
                />
                <span>{dictionary.adminUsers.fields.active}</span>
              </label>

              {success ? <p className="form-success">{success}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}

              <button className="primary-button" disabled={isSubmitting} type="submit">
                {isSubmitting ? dictionary.adminUsers.creating : dictionary.adminUsers.createSubmit}
              </button>
            </form>

            <div className="admin-table-wrap">
              <h2 className="section-title">{dictionary.adminUsers.usersTitle}</h2>
              <div className="table-scroll">
                <table className="users-table">
                  <thead>
                    <tr>
                      <th>{dictionary.adminUsers.columns.displayName}</th>
                      <th>{dictionary.adminUsers.columns.username}</th>
                      <th>{dictionary.adminUsers.columns.email}</th>
                      <th>{dictionary.adminUsers.columns.role}</th>
                      <th>{dictionary.adminUsers.columns.authProvider}</th>
                      <th>{dictionary.adminUsers.columns.active}</th>
                      <th>{dictionary.adminUsers.columns.createdAt}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>{user.display_name}</td>
                        <td>{user.username}</td>
                        <td>{user.email ?? dictionary.adminUsers.emptyValue}</td>
                        <td>{dictionary.adminUsers.roles[user.role]}</td>
                        <td>{user.auth_provider}</td>
                        <td>{user.is_active ? dictionary.adminUsers.yes : dictionary.adminUsers.no}</td>
                        <td>{dateFormatter.format(new Date(user.created_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
