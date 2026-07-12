"use client";

import { FormEvent, KeyboardEvent, SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  createAdminUser,
  getAdminPermissions,
  getAdminUserPermissions,
  getAdminUsers,
  getCurrentUser,
  getLocalizedApiError,
  getStoredAccessToken,
  isAdminRole,
  requireStoredAccessToken,
  resetAdminUserPassword,
  updateAdminUser,
  updateAdminUserPermissions,
  type CreateAdminUserPayload,
  type OfficeChatPermission,
  type OfficeChatUserPermissionState,
  type OfficeChatUser,
  type PermissionKey,
  type UpdateAdminUserPayload,
  type UserRole
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminUsersProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const roles: UserRole[] = ["superadmin", "admin", "group_owner", "moderator", "user", "bot"];
const specialPermissionKeys: PermissionKey[] = ["can_broadcast", "can_pin_messages", "can_manage_calendar"];
type UserStatusFilter = "all" | "active" | "disabled" | "bots";

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
  const [permissionCatalog, setPermissionCatalog] = useState<OfficeChatPermission[]>([]);
  const [selectedPermissionState, setSelectedPermissionState] = useState<OfficeChatUserPermissionState | null>(null);
  const [selectedPermissionDraft, setSelectedPermissionDraft] = useState<PermissionKey[]>([]);
  const [createPermissionDraft, setCreatePermissionDraft] = useState<PermissionKey[]>([]);
  const [createForm, setCreateForm] = useState<CreateAdminUserPayload>(initialCreateForm);
  const [editForm, setEditForm] = useState<UpdateAdminUserPayload>(initialEditForm);
  const [newPassword, setNewPassword] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isLoadingPermissions, setIsLoadingPermissions] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const createDrawerRef = useRef<HTMLElement>(null);
  const editDrawerRef = useRef<HTMLElement>(null);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short"
      }),
    [locale]
  );

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase(locale);

    return users.filter((user) => {
        if (statusFilter === "active") {
          if (!user.is_active) return false;
        }
        if (statusFilter === "disabled") {
          if (user.is_active) return false;
        }
        if (statusFilter === "bots" && user.role !== "bot") {
          return false;
        }
        if (!query) return true;

        return [user.username, user.display_name, user.email ?? ""].some((value) =>
          value.toLocaleLowerCase(locale).includes(query)
        );
      });
  }, [locale, searchQuery, statusFilter, users]);

  useEffect(() => {
    const drawer = isCreateOpen ? createDrawerRef.current : selectedUser ? editDrawerRef.current : null;
    if (!drawer) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector));
    focusable[0]?.focus();

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (isCreateOpen) setIsCreateOpen(false);
        else setSelectedUser(null);
        return;
      }
      if (event.key !== "Tab") return;

      const items = Array.from(drawer!.querySelectorAll<HTMLElement>(focusableSelector));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [isCreateOpen, selectedUser?.id]);

  async function reloadUsers(token: string) {
    const loadedUsers = await getAdminUsers(token);
    setUsers(loadedUsers);
    return loadedUsers;
  }

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const accessToken = token;

    async function loadPage() {
      try {
        const user = await getCurrentUser(accessToken);
        setCurrentUser(user);

        if (!isAdminRole(user.role)) {
          setAccessDenied(true);
          return;
        }

        const loadTasks: Promise<unknown>[] = [reloadUsers(accessToken)];
        if (user.role === "superadmin") {
          loadTasks.push(getAdminPermissions(accessToken).then(setPermissionCatalog));
        }
        await Promise.all(loadTasks);
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
      } finally {
        setIsLoading(false);
      }
    }

    void loadPage();
  }, [locale, router]);

  function selectUser(user: OfficeChatUser) {
    setIsCreateOpen(false);
    setSelectedUser(user);
    setSelectedPermissionState(null);
    setSelectedPermissionDraft([]);
    setEditForm({
      display_name: user.display_name,
      email: user.email ?? "",
      role: user.role,
      is_active: user.is_active
    });
    setNewPassword("");
    setError("");
    setSuccess("");
    if (currentUser?.role === "superadmin") {
      const token = getStoredAccessToken();
      if (!token) return;
      setIsLoadingPermissions(true);
      void getAdminUserPermissions(token, user.id)
        .then((state) => {
          setSelectedPermissionState(state);
          setSelectedPermissionDraft(state.explicit_permissions);
        })
        .catch(() => setError(dictionary.adminUsers.permissions.updateError))
        .finally(() => setIsLoadingPermissions(false));
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, user: OfficeChatUser) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectUser(user);
    }
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
      const createdUser = await createAdminUser(token, {
        ...createForm,
        email: createForm.email?.trim() ? createForm.email.trim() : null,
        username: createForm.username.trim(),
        display_name: createForm.display_name.trim()
      });
      if (
        currentUser?.role === "superadmin" &&
        createForm.role !== "superadmin" &&
        createForm.role !== "bot" &&
        createPermissionDraft.length > 0
      ) {
        await updateAdminUserPermissions(token, createdUser.id, createPermissionDraft);
      }
      setCreateForm(initialCreateForm);
      setCreatePermissionDraft([]);
      await reloadUsers(token);
      setIsCreateOpen(false);
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
      if (currentUser?.role === "superadmin" && editForm.role !== "superadmin" && editForm.role !== "bot") {
        const previous = [...(selectedPermissionState?.explicit_permissions ?? [])].sort().join(",");
        const next = [...selectedPermissionDraft].sort().join(",");
        if (previous !== next) {
          const permissionState = await updateAdminUserPermissions(token, selectedUser.id, selectedPermissionDraft);
          setSelectedPermissionState(permissionState);
          setSelectedPermissionDraft(permissionState.explicit_permissions);
        }
      }
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

  async function handleToggleUserActive(user: OfficeChatUser) {
    if (
      currentUser?.id === user.id ||
      (currentUser?.role === "admin" && user.role === "superadmin")
    ) {
      return;
    }

    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    try {
      const updatedUser = await updateAdminUser(token, user.id, {
        display_name: user.display_name,
        email: user.email,
        role: user.role,
        is_active: !user.is_active
      });
      const loadedUsers = await reloadUsers(token);
      setSelectedUser((currentSelected) => {
        if (currentSelected?.id === updatedUser.id) {
          setEditForm({
            display_name: updatedUser.display_name,
            email: updatedUser.email ?? "",
            role: updatedUser.role,
            is_active: updatedUser.is_active
          });
          return updatedUser;
        }
        return currentSelected && !loadedUsers.some((loadedUser) => loadedUser.id === currentSelected.id)
          ? null
          : currentSelected;
      });
      setSuccess(
        updatedUser.is_active
          ? dictionary.adminUsers.enableSuccess
          : dictionary.adminUsers.disableSuccess
      );
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminUsers.updateError);
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

  function canToggleUserActive(user: OfficeChatUser) {
    if (!currentUser) {
      return false;
    }
    if (currentUser.id === user.id) {
      return false;
    }
    if (currentUser.role === "admin" && user.role === "superadmin") {
      return false;
    }
    return true;
  }

  function permissionDescription(permission: OfficeChatPermission, language: Locale) {
    return language === "ru" ? permission.description_ru : permission.description_en;
  }

  function togglePermission(
    permission: PermissionKey,
    checked: boolean,
    setter: (value: SetStateAction<PermissionKey[]>) => void
  ) {
    setter((current) => {
      if (checked) return Array.from(new Set([...current, permission]));
      return current.filter((item) => item !== permission);
    });
  }

  function renderPermissionControls(options: {
    role: UserRole;
    authProvider: string;
    draft: PermissionKey[];
    state?: OfficeChatUserPermissionState | null;
    onChange: (permission: PermissionKey, checked: boolean) => void;
  }) {
    if (currentUser?.role !== "superadmin") {
      return null;
    }

    const inherited = options.role === "superadmin" || Boolean(options.state?.inherited_from_superadmin);
    const isBot = options.role === "bot" || options.authProvider === "bot";
    const availableCatalog = permissionCatalog.length > 0
      ? permissionCatalog
      : specialPermissionKeys.map((key) => ({
          key,
          category: "security",
          description_ru: dictionary.adminUsers.permissions.items[key].description,
          description_en: dictionary.adminUsers.permissions.items[key].description,
          is_active: true,
          created_at: "",
          updated_at: ""
        }));

    return (
      <section className="special-permissions-section" aria-labelledby="special-permissions-title">
        <div>
          <h3 className="compact-title" id="special-permissions-title">
            {dictionary.adminUsers.permissions.title}
          </h3>
          <p className="permission-warning">{dictionary.adminUsers.permissions.warning}</p>
        </div>
        {isLoadingPermissions ? <p className="muted">{dictionary.adminUsers.permissions.loading}</p> : null}
        {inherited ? <p className="form-success">{dictionary.adminUsers.permissions.inherited}</p> : null}
        {isBot ? <p className="muted">{dictionary.adminUsers.permissions.botNotSupported}</p> : null}
        <div className="special-permissions-list">
          {availableCatalog.map((permission) => {
            const checked = inherited || options.draft.includes(permission.key);
            return (
              <label className="permission-toggle" key={permission.key}>
                <input
                  checked={checked}
                  disabled={inherited || isBot}
                  onChange={(event) => options.onChange(permission.key, event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>{dictionary.adminUsers.permissions.items[permission.key].label}</strong>
                  {permission.key === "can_broadcast" ? (
                    <em>{dictionary.adminUsers.permissions.highImpact}</em>
                  ) : null}
                  <small>{permissionDescription(permission, locale)}</small>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <main className="admin-page admin-users-page">
      <section className="admin-shell admin-users-shell" aria-label={dictionary.adminUsers.ariaLabel}>
        <div className="dashboard-header admin-users-header">
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
          <>
            <div className="admin-users-toolbar">
              <h2 className="section-title">{dictionary.adminUsers.usersTitle}</h2>
              <label className="admin-users-control">
                <span className="field-label">{dictionary.adminUsers.filterLabel}</span>
                <select
                  className="table-select"
                  onChange={(event) => setStatusFilter(event.target.value as UserStatusFilter)}
                  value={statusFilter}
                >
                  <option value="all">{dictionary.adminUsers.filters.all}</option>
                  <option value="active">{dictionary.adminUsers.filters.active}</option>
                  <option value="disabled">{dictionary.adminUsers.filters.disabled}</option>
                  <option value="bots">{dictionary.adminUsers.filters.bots}</option>
                </select>
              </label>
              <label className="admin-users-control admin-users-search">
                <span className="field-label">{dictionary.adminUsers.searchLabel}</span>
                <input
                  className="field-input"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={dictionary.adminUsers.searchPlaceholder}
                  type="search"
                  value={searchQuery}
                />
              </label>
              <button
                className="primary-button admin-users-create-button"
                onClick={() => {
                  setSelectedUser(null);
                  setError("");
                  setSuccess("");
                  setCreatePermissionDraft([]);
                  setIsCreateOpen(true);
                }}
                type="button"
              >
                {dictionary.adminUsers.createTitle}
              </button>
            </div>

            {success ? <p className="form-success admin-users-feedback">{success}</p> : null}
            {error && !isCreateOpen && !selectedUser ? <p className="form-error admin-users-feedback">{error}</p> : null}

            <div className="admin-table-wrap admin-users-table-wrap">
              <div className="table-scroll admin-users-table-scroll">
                <table className="users-table admin-users-table">
                  <thead>
                    <tr>
                      <th className="user-col-name">{dictionary.adminUsers.columns.displayName}</th>
                      <th className="user-col-username">{dictionary.adminUsers.columns.username}</th>
                      <th className="user-col-email">{dictionary.adminUsers.columns.email}</th>
                      <th className="user-col-role">{dictionary.adminUsers.columns.role}</th>
                      <th className="user-col-source">{dictionary.adminUsers.columns.authProvider}</th>
                      <th className="user-col-active">{dictionary.adminUsers.columns.active}</th>
                      <th className="user-col-created">{dictionary.adminUsers.columns.createdAt}</th>
                      <th className="user-col-actions">{dictionary.adminUsers.columns.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => {
                      const rowClass = [
                        user.is_active ? "" : "muted-row",
                        selectedUser?.id === user.id ? "selected-row" : ""
                      ].filter(Boolean).join(" ");
                      return (
                        <tr
                          aria-selected={selectedUser?.id === user.id}
                          className={rowClass || undefined}
                          key={user.id}
                          onClick={() => selectUser(user)}
                          onKeyDown={(event) => handleRowKeyDown(event, user)}
                          tabIndex={0}
                        >
                          <td className="user-col-name"><span className="user-cell-ellipsis" title={user.display_name}>{user.display_name}</span></td>
                          <td className="user-col-username"><span className="user-cell-ellipsis" title={user.username}>{user.username}</span></td>
                          <td className="user-col-email"><span className="user-cell-ellipsis" title={user.email ?? dictionary.adminUsers.emptyValue}>{user.email ?? dictionary.adminUsers.emptyValue}</span></td>
                          <td className="user-col-role"><span className="user-cell-ellipsis" title={dictionary.adminUsers.roles[user.role]}>{dictionary.adminUsers.roles[user.role]}</span></td>
                          <td className="user-col-source"><span className="user-cell-ellipsis" title={user.auth_provider}>{user.auth_provider}</span></td>
                          <td className="user-col-active"><span className={`user-status ${user.is_active ? "user-status-active" : "user-status-disabled"}`}>{user.is_active ? dictionary.adminUsers.yes : dictionary.adminUsers.no}</span></td>
                          <td className="user-col-created" title={user.created_at}>{dateFormatter.format(new Date(user.created_at))}</td>
                          <td className="user-col-actions">
                            <div className="table-actions admin-user-actions">
                              <button className="table-action" onClick={(event) => { event.stopPropagation(); selectUser(user); }} type="button">
                                {dictionary.adminUsers.editAction}
                              </button>
                              <button
                                className="table-action"
                                disabled={!canToggleUserActive(user)}
                                onClick={(event) => { event.stopPropagation(); void handleToggleUserActive(user); }}
                                type="button"
                              >
                                {user.is_active ? dictionary.adminUsers.disableAction : dictionary.adminUsers.enableAction}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredUsers.length === 0 ? <p className="sidebar-empty-state">{dictionary.adminUsers.noResults}</p> : null}
              </div>

              <div className="admin-user-cards">
                {filteredUsers.map((user) => (
                  <article className={`admin-user-card ${user.is_active ? "" : "muted-card"} ${selectedUser?.id === user.id ? "selected-card" : ""}`} key={user.id}>
                    <div className="admin-user-card-heading">
                      <div className="admin-user-card-name"><strong title={user.display_name}>{user.display_name}</strong><span title={user.username}>@{user.username}</span></div>
                      <span className={`user-status ${user.is_active ? "user-status-active" : "user-status-disabled"}`}>{user.is_active ? dictionary.adminUsers.yes : dictionary.adminUsers.no}</span>
                    </div>
                    <p className="admin-user-card-email" title={user.email ?? dictionary.adminUsers.emptyValue}>{user.email ?? dictionary.adminUsers.emptyValue}</p>
                    <div className="admin-user-card-meta"><span>{dictionary.adminUsers.roles[user.role]}</span><span>{user.auth_provider}</span></div>
                    <div className="table-actions">
                      <button className="table-action" onClick={() => selectUser(user)} type="button">{dictionary.adminUsers.editAction}</button>
                      <button className="table-action" disabled={!canToggleUserActive(user)} onClick={() => void handleToggleUserActive(user)} type="button">
                        {user.is_active ? dictionary.adminUsers.disableAction : dictionary.adminUsers.enableAction}
                      </button>
                    </div>
                  </article>
                ))}
                {filteredUsers.length === 0 ? <p className="sidebar-empty-state">{dictionary.adminUsers.noResults}</p> : null}
              </div>
            </div>
          </>
        ) : null}
      </section>

      {isCreateOpen ? (
        <div className="admin-user-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCreateOpen(false); }} role="presentation">
          <section aria-labelledby="create-user-title" aria-modal="true" className="admin-user-drawer" ref={createDrawerRef} role="dialog">
            <div className="admin-user-drawer-header"><h2 id="create-user-title">{dictionary.adminUsers.createTitle}</h2><button className="secondary-link" onClick={() => setIsCreateOpen(false)} type="button">{dictionary.adminUsers.close}</button></div>
            <form className="admin-form" onSubmit={handleCreateSubmit}>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.username}</span><input autoFocus className="field-input" onChange={(event) => updateCreateForm("username", event.target.value)} required type="text" value={createForm.username} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.displayName}</span><input className="field-input" onChange={(event) => updateCreateForm("display_name", event.target.value)} required type="text" value={createForm.display_name} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.email}</span><input className="field-input" onChange={(event) => updateCreateForm("email", event.target.value)} type="email" value={createForm.email ?? ""} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.password}</span><input autoComplete="new-password" className="field-input" minLength={8} onChange={(event) => updateCreateForm("password", event.target.value)} required type="password" value={createForm.password} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.role}</span><select className="field-input" onChange={(event) => updateCreateForm("role", event.target.value as UserRole)} value={createForm.role}>{roles.map((role) => <option key={role} value={role}>{dictionary.adminUsers.roles[role]}</option>)}</select></label>
              <label className="checkbox-field"><input checked={createForm.is_active} onChange={(event) => updateCreateForm("is_active", event.target.checked)} type="checkbox" /><span>{dictionary.adminUsers.fields.active}</span></label>
              {renderPermissionControls({
                role: createForm.role,
                authProvider: "local",
                draft: createPermissionDraft,
                onChange: (permission, checked) => togglePermission(permission, checked, setCreatePermissionDraft)
              })}
              {error ? <p className="form-error">{error}</p> : null}
              <div className="admin-user-drawer-actions"><button className="primary-button" disabled={isCreating} type="submit">{isCreating ? dictionary.adminUsers.creating : dictionary.adminUsers.createSubmit}</button><button className="secondary-link" onClick={() => setIsCreateOpen(false)} type="button">{dictionary.adminUsers.cancel}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {selectedUser ? (
        <div className="admin-user-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedUser(null); }} role="presentation">
          <section aria-labelledby="edit-user-title" aria-modal="true" className="admin-user-drawer" ref={editDrawerRef} role="dialog">
            <div className="admin-user-drawer-header"><div><h2 id="edit-user-title">{dictionary.adminUsers.editTitle}</h2><p className="admin-current">{selectedUser.display_name} · {selectedUser.auth_provider}</p></div><button className="secondary-link" onClick={() => setSelectedUser(null)} type="button">{dictionary.adminUsers.close}</button></div>
            <form className="admin-form" onSubmit={handleEditSubmit}>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.username}</span><input className="field-input" readOnly type="text" value={selectedUser.username} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.displayName}</span><input className="field-input" onChange={(event) => updateEditForm("display_name", event.target.value)} required type="text" value={editForm.display_name} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.email}</span><input className="field-input" onChange={(event) => updateEditForm("email", event.target.value)} type="email" value={editForm.email ?? ""} /></label>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.role}</span><select className="field-input" onChange={(event) => updateEditForm("role", event.target.value as UserRole)} value={editForm.role}>{roles.map((role) => <option key={role} value={role}>{dictionary.adminUsers.roles[role]}</option>)}</select></label>
              <label className="checkbox-field"><input checked={editForm.is_active} onChange={(event) => updateEditForm("is_active", event.target.checked)} type="checkbox" /><span>{dictionary.adminUsers.fields.active}</span></label>
              {renderPermissionControls({
                role: editForm.role,
                authProvider: selectedUser.auth_provider,
                draft: selectedPermissionDraft,
                state: selectedPermissionState,
                onChange: (permission, checked) => togglePermission(permission, checked, setSelectedPermissionDraft)
              })}
              <div className="admin-user-drawer-actions"><button className="primary-button" disabled={isSaving} type="submit">{isSaving ? dictionary.adminUsers.saving : dictionary.adminUsers.saveSubmit}</button><button className="secondary-link" onClick={() => setSelectedUser(null)} type="button">{dictionary.adminUsers.cancel}</button></div>
            </form>
            <form className="admin-form reset-form" onSubmit={handleResetPassword}>
              <h3 className="compact-title">{dictionary.adminUsers.resetTitle}</h3>
              <label className="field"><span className="field-label">{dictionary.adminUsers.fields.newPassword}</span><input autoComplete="new-password" className="field-input" minLength={8} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></label>
              <button className="secondary-link" disabled={isResetting} type="submit">{isResetting ? dictionary.adminUsers.resetting : dictionary.adminUsers.resetSubmit}</button>
            </form>
            {success ? <p className="form-success">{success}</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
