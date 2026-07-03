"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  createGroup,
  getCurrentUser,
  getLocalizedApiError,
  getGroups,
  getStoredAccessToken,
  isAdminRole,
  requireStoredAccessToken,
  updateGroup,
  type CreateGroupPayload,
  type OfficeChatGroup,
  type OfficeChatUser
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type GroupsProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const initialForm: CreateGroupPayload = {
  name: "",
  slug: "",
  description: "",
  is_private: true,
  is_active: true
};

export function Groups({ dictionary, locale }: GroupsProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [groups, setGroups] = useState<OfficeChatGroup[]>([]);
  const [form, setForm] = useState<CreateGroupPayload>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [updatingGroupId, setUpdatingGroupId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function reloadGroups(token: string, user = currentUser) {
    setGroups(await getGroups(token, Boolean(user && isAdminRole(user.role))));
  }

  useEffect(() => {
    const token = requireStoredAccessToken(locale);
    if (!token) return;
    const accessToken = token;

    async function loadPage() {
      try {
        const loadedUser = await getCurrentUser(accessToken);
        setCurrentUser(loadedUser);
        await reloadGroups(accessToken, loadedUser);
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
      } finally {
        setIsLoading(false);
      }
    }

    void loadPage();
  }, [locale, router]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
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
      await createGroup(token, {
        ...form,
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description?.trim() ? form.description.trim() : null
      });
      setForm(initialForm);
      await reloadGroups(token);
      setSuccess(dictionary.groups.createSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groups.createError);
    } finally {
      setIsCreating(false);
    }
  }

  function updateForm<Key extends keyof CreateGroupPayload>(key: Key, value: CreateGroupPayload[Key]) {
    setForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  async function handleToggleGroupActive(group: OfficeChatGroup) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setUpdatingGroupId(group.id);
    try {
      await updateGroup(token, group.id, {
        name: group.name,
        description: group.description,
        is_private: group.is_private,
        is_active: !group.is_active
      });
      await reloadGroups(token);
      setSuccess(group.is_active ? dictionary.groups.archiveSuccess : dictionary.groups.restoreSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groups.archiveError);
    } finally {
      setUpdatingGroupId(null);
    }
  }

  return (
    <main className="admin-page">
      <section className="admin-shell" aria-label={dictionary.groups.ariaLabel}>
        <div className="dashboard-header">
          <div>
            <Link className="locale-link" href={`/${locale}/dashboard`}>
              {dictionary.groups.backToDashboard}
            </Link>
            <h1 className="dashboard-title admin-title">{dictionary.groups.title}</h1>
          </div>
        </div>

        {isLoading ? <p className="muted">{dictionary.groups.loading}</p> : null}

        {!isLoading ? (
          <div className="admin-grid">
            <div className="admin-side">
              {currentUser && isAdminRole(currentUser.role) ? (
                <form className="admin-form" onSubmit={handleCreate}>
                  <h2 className="section-title">{dictionary.groups.createTitle}</h2>
                  <label className="field">
                    <span className="field-label">{dictionary.groups.fields.name}</span>
                    <input
                      className="field-input"
                      onChange={(event) => updateForm("name", event.target.value)}
                      required
                      type="text"
                      value={form.name}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{dictionary.groups.fields.slug}</span>
                    <input
                      className="field-input"
                      onChange={(event) => updateForm("slug", event.target.value)}
                      required
                      type="text"
                      value={form.slug}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{dictionary.groups.fields.description}</span>
                    <textarea
                      className="field-input textarea-input"
                      onChange={(event) => updateForm("description", event.target.value)}
                      value={form.description ?? ""}
                    />
                  </label>
                  <label className="checkbox-field">
                    <input
                      checked={form.is_private}
                      onChange={(event) => updateForm("is_private", event.target.checked)}
                      type="checkbox"
                    />
                    <span>{dictionary.groups.fields.private}</span>
                  </label>
                  <label className="checkbox-field">
                    <input
                      checked={form.is_active}
                      onChange={(event) => updateForm("is_active", event.target.checked)}
                      type="checkbox"
                    />
                    <span>{dictionary.groups.fields.active}</span>
                  </label>
                  <button className="primary-button" disabled={isCreating} type="submit">
                    {isCreating ? dictionary.groups.creating : dictionary.groups.createSubmit}
                  </button>
                </form>
              ) : (
                <p className="muted">{dictionary.groups.memberOnlyNote}</p>
              )}

              {success ? <p className="form-success">{success}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}
            </div>

            <div className="admin-table-wrap">
              <h2 className="section-title">{dictionary.groups.listTitle}</h2>
              <div className="groups-list">
                {groups.map((group) => (
                  <article className={group.is_active ? "group-card" : "group-card muted-card"} key={group.id}>
                    <div>
                      <h3 className="compact-title">{group.name}</h3>
                      <p className="admin-current">{group.slug}</p>
                      <p className="muted">{group.description ?? dictionary.groups.emptyDescription}</p>
                    </div>
                    <div className="group-meta">
                      <span>{group.is_private ? dictionary.groups.private : dictionary.groups.public}</span>
                      <span>{group.is_active ? dictionary.groups.active : dictionary.groups.inactive}</span>
                    </div>
                    <div className="table-actions">
                      <Link className="secondary-link" href={`/${locale}/groups/${group.id}`}>
                        {dictionary.groups.open}
                      </Link>
                      {currentUser && isAdminRole(currentUser.role) ? (
                        <button
                          className="table-action"
                          disabled={updatingGroupId === group.id}
                          onClick={() => void handleToggleGroupActive(group)}
                          type="button"
                        >
                          {group.is_active ? dictionary.groups.archive : dictionary.groups.restore}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
