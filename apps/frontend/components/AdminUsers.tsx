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
  resetAdminUserPassword,
  updateAdminUser,
  type CreateAdminUserPayload,
  type OfficeChatUser,
  type UpdateAdminUserPayload,
  type UserRole
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminUsersProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const roles: UserRole[] = ["superadmin", "admin", "group_owner", "moderator", "user", "bot"];

const initialCreateForm: CreateAdminUserPayload = {
  username: "",
  display_name: "",
  email: "",
  password: "",
  role: "user",
  is_active: true
};

const initialEditForm: UpdateAdminUserPayload = {
  display_name: "",
  email: "",
  role: "user",
  is_active: true
};

export function AdminUsers({ dictionary, locale }: AdminUsersProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [users, setUsers] = useState<OfficeChatUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<OfficeChatUser | null>(null);
  const [createForm, setCreateForm] = useState<CreateAdminUserPayload>(initialCreateForm);
  const [editForm, setEditForm] = useState<UpdateAdminUserPayload>(initialEditForm);
  const [newPassword, setNewPassword] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
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
    return loadedUsers;
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

  function selectUser(user: OfficeChatUser) {
    setSelectedUser(user);
    setEditForm({
      display_name: user.display_name,
      email: user.email ?? "",
      role: user.role,
      is_active: user.is_active
    });
    setNewPassword("");
    setError("");
    setSuccess("");
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setIsCreating(true);
    try {
      await createAdminUser(token, {
        ...createForm,
        email: createForm.email?.trim() ? createForm.email.trim() : null,
        username: createForm.username.trim(),
        display_name: createForm.display_name.trim()
      });
      setCreateForm(initialCreateForm);
      await reloadUsers(token);
      setSuccess(dictionary.adminUsers.createSuccess);
    } catch (caughtError) {
      setCreateForm((currentForm) => ({ ...currentForm, password: "" }));
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminUsers.createError);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token || !selectedUser) {
      router.replace(`/${locale}/login`);
      return;
    }

    setIsSaving(true);
    try {
      const updatedUser = await updateAdminUser(token, selectedUser.id, {
        ...editForm,
        email: editForm.email?.trim() ? editForm.email.trim() : null,
        display_name: editForm.display_name.trim()
      });
      setSelectedUser(updatedUser);
      await reloadUsers(token);
      setSuccess(dictionary.adminUsers.updateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminUsers.updateError);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token || !selectedUser) {
      router.replace(`/${locale}/login`);
      return;
    }

    setIsResetting(true);
    try {
      const updatedUser = await resetAdminUserPassword(token, selectedUser.id, newPassword);
      setSelectedUser(updatedUser);
      setNewPassword("");
      await reloadUsers(token);
      setSuccess(dictionary.adminUsers.resetSuccess);
    } catch (caughtError) {
      setNewPassword("");
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminUsers.resetError);
    } finally {
      setIsResetting(false);
    }
  }

  function updateCreateForm<Key extends keyof CreateAdminUserPayload>(
    key: Key,
    value: CreateAdminUserPayload[Key]
  ) {
    setCreateForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  function updateEditForm<Key extends keyof UpdateAdminUserPayload>(
    key: Key,
    value: UpdateAdminUserPayload[Key]
  ) {
    setEditForm((currentForm) => ({ ...currentForm, [key]: value }));
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
            <div className="admin-side">
              <form className="admin-form" onSubmit={handleCreateSubmit}>
                <h2 className="section-title">{dictionary.adminUsers.createTitle}</h2>

                <label className="field">
                  <span className="field-label">{dictionary.adminUsers.fields.username}</span>
                  <input
                    className="field-input"
                    onChange={(event) => updateCreateForm("username", event.target.value)}
                    required
                    type="text"
                    value={createForm.username}
                  />
                </label>

                <label className="field">
                  <span className="field-label">{dictionary.adminUsers.fields.displayName}</span>
                  <input
                    className="field-input"
                    onChange={(event) => updateCreateForm("display_name", event.target.value)}
                    required
                    type="text"
                    value={createForm.display_name}
                  />
                </label>

                <label className="field">
                  <span className="field-label">{dictionary.adminUsers.fields.email}</span>
                  <input
                    className="field-input"
                    onChange={(event) => updateCreateForm("email", event.target.value)}
                    type="email"
                    value={createForm.email ?? ""}
                  />
                </label>

                <label className="field">
                  <span className="field-label">{dictionary.adminUsers.fields.password}</span>
                  <input
                    autoComplete="new-password"
                    className="field-input"
                    minLength={8}
                    onChange={(event) => updateCreateForm("password", event.target.value)}
                    required
                    type="password"
                    value={createForm.password}
                  />
                </label>

                <label className="field">
                  <span className="field-label">{dictionary.adminUsers.fields.role}</span>
                  <select
                    className="field-input"
                    onChange={(event) => updateCreateForm("role", event.target.value as UserRole)}
                    value={createForm.role}
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
                    checked={createForm.is_active}
                    onChange={(event) => updateCreateForm("is_active", event.target.checked)}
                    type="checkbox"
                  />
                  <span>{dictionary.adminUsers.fields.active}</span>
                </label>

                <button className="primary-button" disabled={isCreating} type="submit">
                  {isCreating ? dictionary.adminUsers.creating : dictionary.adminUsers.createSubmit}
                </button>
              </form>

              <section className="admin-form edit-panel" aria-label={dictionary.adminUsers.editTitle}>
                <h2 className="section-title">{dictionary.adminUsers.editTitle}</h2>
                {!selectedUser ? <p className="muted">{dictionary.adminUsers.selectUserHelp}</p> : null}

                {selectedUser ? (
                  <>
                    <p className="admin-current">
                      {selectedUser.username} · {selectedUser.auth_provider}
                    </p>
                    <form className="admin-form" onSubmit={handleEditSubmit}>
                      <label className="field">
                        <span className="field-label">{dictionary.adminUsers.fields.displayName}</span>
                        <input
                          className="field-input"
                          onChange={(event) => updateEditForm("display_name", event.target.value)}
                          required
                          type="text"
                          value={editForm.display_name}
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">{dictionary.adminUsers.fields.email}</span>
                        <input
                          className="field-input"
                          onChange={(event) => updateEditForm("email", event.target.value)}
                          type="email"
                          value={editForm.email ?? ""}
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">{dictionary.adminUsers.fields.role}</span>
                        <select
                          className="field-input"
                          onChange={(event) => updateEditForm("role", event.target.value as UserRole)}
                          value={editForm.role}
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
                          checked={editForm.is_active}
                          onChange={(event) => updateEditForm("is_active", event.target.checked)}
                          type="checkbox"
                        />
                        <span>{dictionary.adminUsers.fields.active}</span>
                      </label>

                      <button className="primary-button" disabled={isSaving} type="submit">
                        {isSaving ? dictionary.adminUsers.saving : dictionary.adminUsers.saveSubmit}
                      </button>
                    </form>

                    <form className="admin-form reset-form" onSubmit={handleResetPassword}>
                      <h3 className="compact-title">{dictionary.adminUsers.resetTitle}</h3>
                      <label className="field">
                        <span className="field-label">{dictionary.adminUsers.fields.newPassword}</span>
                        <input
                          autoComplete="new-password"
                          className="field-input"
                          minLength={8}
                          onChange={(event) => setNewPassword(event.target.value)}
                          required
                          type="password"
                          value={newPassword}
                        />
                      </label>
                      <button className="secondary-link" disabled={isResetting} type="submit">
                        {isResetting ? dictionary.adminUsers.resetting : dictionary.adminUsers.resetSubmit}
                      </button>
                    </form>
                  </>
                ) : null}
              </section>

              {success ? <p className="form-success">{success}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}
            </div>

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
                      <th>{dictionary.adminUsers.columns.actions}</th>
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
                        <td>
                          <button className="table-action" onClick={() => selectUser(user)} type="button">
                            {dictionary.adminUsers.editAction}
                          </button>
                        </td>
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
