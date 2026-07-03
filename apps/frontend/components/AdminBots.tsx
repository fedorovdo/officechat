"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  createAdminBot,
  getAdminBots,
  getCurrentUser,
  getLocalizedApiError,
  getStoredAccessToken,
  isAdminRole,
  requireStoredAccessToken,
  rotateAdminBotToken,
  updateAdminBot,
  type CreateAdminBotPayload,
  type OfficeChatBot,
  type OfficeChatUser,
  type UpdateAdminBotPayload
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type AdminBotsProps = {
  dictionary: Dictionary;
  locale: Locale;
};

const initialCreateForm: CreateAdminBotPayload = {
  name: "",
  description: ""
};

const initialEditForm: UpdateAdminBotPayload = {
  name: "",
  description: "",
  is_active: true
};

export function AdminBots({ dictionary, locale }: AdminBotsProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [bots, setBots] = useState<OfficeChatBot[]>([]);
  const [selectedBot, setSelectedBot] = useState<OfficeChatBot | null>(null);
  const [createForm, setCreateForm] = useState<CreateAdminBotPayload>(initialCreateForm);
  const [editForm, setEditForm] = useState<UpdateAdminBotPayload>(initialEditForm);
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [oneTimeTokenBotName, setOneTimeTokenBotName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
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

  const webhookExample = oneTimeToken
    ? `curl.exe -X POST http://localhost:8100/api/bots/incoming/${oneTimeToken} -H "Content-Type: application/json" -d "{\\"group_slug\\":\\"alerts\\",\\"title\\":\\"Backup failed\\",\\"severity\\":\\"high\\",\\"body\\":\\"Check server\\"}"`
    : "";

  async function reloadBots(token: string) {
    const loadedBots = await getAdminBots(token);
    setBots(loadedBots);
    return loadedBots;
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

        await reloadBots(accessToken);
      } catch (caughtError) {
        setError(getLocalizedApiError(caughtError, dictionary.session));
      } finally {
        setIsLoading(false);
      }
    }

    void loadPage();
  }, [locale, router]);

  function selectBot(bot: OfficeChatBot) {
    setSelectedBot(bot);
    setEditForm({
      name: bot.name,
      description: bot.description ?? "",
      is_active: bot.is_active
    });
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
      const createdBot = await createAdminBot(token, {
        name: createForm.name.trim(),
        description: createForm.description?.trim() ? createForm.description.trim() : null
      });
      setOneTimeToken(createdBot.token);
      setOneTimeTokenBotName(createdBot.name);
      setCreateForm(initialCreateForm);
      await reloadBots(token);
      setSuccess(dictionary.adminBots.createSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminBots.createError);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    const token = getStoredAccessToken();
    if (!token || !selectedBot) {
      router.replace(`/${locale}/login`);
      return;
    }

    setIsSaving(true);
    try {
      const updatedBot = await updateAdminBot(token, selectedBot.id, {
        name: editForm.name?.trim(),
        description: editForm.description?.trim() ? editForm.description.trim() : null,
        is_active: editForm.is_active
      });
      setSelectedBot(updatedBot);
      await reloadBots(token);
      setSuccess(dictionary.adminBots.updateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminBots.updateError);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleActive(bot: OfficeChatBot) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    try {
      const updatedBot = await updateAdminBot(token, bot.id, { is_active: !bot.is_active });
      if (selectedBot?.id === bot.id) {
        selectBot(updatedBot);
      }
      await reloadBots(token);
      setSuccess(dictionary.adminBots.updateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminBots.updateError);
    }
  }

  async function handleRotateToken(bot: OfficeChatBot) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setIsRotating(true);
    try {
      const response = await rotateAdminBotToken(token, bot.id);
      setOneTimeToken(response.token);
      setOneTimeTokenBotName(response.bot.name);
      if (selectedBot?.id === bot.id) {
        selectBot(response.bot);
      }
      await reloadBots(token);
      setSuccess(dictionary.adminBots.rotateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.adminBots.rotateError);
    } finally {
      setIsRotating(false);
    }
  }

  function updateCreateForm<Key extends keyof CreateAdminBotPayload>(
    key: Key,
    value: CreateAdminBotPayload[Key]
  ) {
    setCreateForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  function updateEditForm<Key extends keyof UpdateAdminBotPayload>(
    key: Key,
    value: UpdateAdminBotPayload[Key]
  ) {
    setEditForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  return (
    <main className="admin-page">
      <section className="admin-shell" aria-label={dictionary.adminBots.ariaLabel}>
        <div className="dashboard-header">
          <div>
            <Link className="locale-link" href={`/${locale}/dashboard`}>
              {dictionary.adminBots.backToDashboard}
            </Link>
            <h1 className="dashboard-title admin-title">{dictionary.adminBots.title}</h1>
            {currentUser ? (
              <p className="admin-current">
                {currentUser.display_name} / {currentUser.username} / {currentUser.role}
              </p>
            ) : null}
          </div>
        </div>

        {isLoading ? <p className="muted">{dictionary.adminBots.loading}</p> : null}
        {accessDenied ? <p className="access-denied">{dictionary.adminBots.accessDenied}</p> : null}

        {!isLoading && !accessDenied ? (
          <div className="admin-grid">
            <div className="admin-side">
              <form className="admin-form" onSubmit={handleCreateSubmit}>
                <h2 className="section-title">{dictionary.adminBots.createTitle}</h2>
                <label className="field">
                  <span className="field-label">{dictionary.adminBots.fields.name}</span>
                  <input
                    className="field-input"
                    onChange={(event) => updateCreateForm("name", event.target.value)}
                    required
                    type="text"
                    value={createForm.name}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{dictionary.adminBots.fields.description}</span>
                  <textarea
                    className="field-input textarea-input"
                    onChange={(event) => updateCreateForm("description", event.target.value)}
                    value={createForm.description ?? ""}
                  />
                </label>
                <button className="primary-button" disabled={isCreating} type="submit">
                  {isCreating ? dictionary.adminBots.creating : dictionary.adminBots.createSubmit}
                </button>
              </form>

              {oneTimeToken ? (
                <section className="token-panel" aria-label={dictionary.adminBots.tokenTitle}>
                  <h2 className="section-title">{dictionary.adminBots.tokenTitle}</h2>
                  <p className="muted">
                    {dictionary.adminBots.tokenWarning} {oneTimeTokenBotName}
                  </p>
                  <code className="token-value">{oneTimeToken}</code>
                  <h3 className="compact-title">{dictionary.adminBots.exampleTitle}</h3>
                  <code className="token-value">{webhookExample}</code>
                </section>
              ) : null}

              <section className="admin-form edit-panel" aria-label={dictionary.adminBots.editTitle}>
                <h2 className="section-title">{dictionary.adminBots.editTitle}</h2>
                {!selectedBot ? <p className="muted">{dictionary.adminBots.selectBotHelp}</p> : null}
                {selectedBot ? (
                  <form className="admin-form" onSubmit={handleEditSubmit}>
                    <p className="admin-current">
                      {selectedBot.user.username} / {selectedBot.token_preview}
                    </p>
                    <label className="field">
                      <span className="field-label">{dictionary.adminBots.fields.name}</span>
                      <input
                        className="field-input"
                        onChange={(event) => updateEditForm("name", event.target.value)}
                        required
                        type="text"
                        value={editForm.name ?? ""}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">{dictionary.adminBots.fields.description}</span>
                      <textarea
                        className="field-input textarea-input"
                        onChange={(event) => updateEditForm("description", event.target.value)}
                        value={editForm.description ?? ""}
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        checked={Boolean(editForm.is_active)}
                        onChange={(event) => updateEditForm("is_active", event.target.checked)}
                        type="checkbox"
                      />
                      <span>{dictionary.adminBots.fields.active}</span>
                    </label>
                    <button className="primary-button" disabled={isSaving} type="submit">
                      {isSaving ? dictionary.adminBots.saving : dictionary.adminBots.saveSubmit}
                    </button>
                  </form>
                ) : null}
              </section>

              {success ? <p className="form-success">{success}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}
            </div>

            <div className="admin-table-wrap">
              <h2 className="section-title">{dictionary.adminBots.botsTitle}</h2>
              <div className="table-scroll">
                <table className="users-table">
                  <thead>
                    <tr>
                      <th>{dictionary.adminBots.columns.name}</th>
                      <th>{dictionary.adminBots.columns.username}</th>
                      <th>{dictionary.adminBots.columns.description}</th>
                      <th>{dictionary.adminBots.columns.tokenPreview}</th>
                      <th>{dictionary.adminBots.columns.active}</th>
                      <th>{dictionary.adminBots.columns.lastUsedAt}</th>
                      <th>{dictionary.adminBots.columns.createdAt}</th>
                      <th>{dictionary.adminBots.columns.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bots.map((bot) => (
                      <tr key={bot.id}>
                        <td>{bot.name}</td>
                        <td>{bot.user.username}</td>
                        <td>{bot.description ?? dictionary.adminBots.emptyValue}</td>
                        <td>{bot.token_preview}</td>
                        <td>{bot.is_active ? dictionary.adminBots.yes : dictionary.adminBots.no}</td>
                        <td>
                          {bot.last_used_at
                            ? dateFormatter.format(new Date(bot.last_used_at))
                            : dictionary.adminBots.emptyValue}
                        </td>
                        <td>{dateFormatter.format(new Date(bot.created_at))}</td>
                        <td>
                          <div className="table-actions">
                            <button className="table-action" onClick={() => selectBot(bot)} type="button">
                              {dictionary.adminBots.editAction}
                            </button>
                            <button
                              className="table-action"
                              onClick={() => void handleToggleActive(bot)}
                              type="button"
                            >
                              {bot.is_active ? dictionary.adminBots.disableAction : dictionary.adminBots.enableAction}
                            </button>
                            <button
                              className="table-action"
                              disabled={isRotating}
                              onClick={() => void handleRotateToken(bot)}
                              type="button"
                            >
                              {dictionary.adminBots.rotateAction}
                            </button>
                          </div>
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
