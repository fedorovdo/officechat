"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  addGroupMember,
  clearStoredAccessToken,
  deleteGroupMessage,
  downloadAttachment,
  editGroupMessage,
  getCurrentUser,
  getGroup,
  getGroupMembers,
  getGroupMessages,
  getGroupWebSocketUrl,
  getStoredAccessToken,
  isAdminRole,
  removeGroupMember,
  sendGroupMessage,
  sendGroupMessageWithAttachment,
  updateGroup,
  updateGroupMember,
  type GroupMessageEvent,
  type GroupRole,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
  type OfficeChatMessage,
  type OfficeChatUser,
  type UpdateGroupPayload
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type GroupDetailsProps = {
  dictionary: Dictionary;
  groupId: string;
  locale: Locale;
};

const groupRoles: GroupRole[] = ["owner", "moderator", "member"];
type LiveUpdateStatus = "connected" | "disconnected" | "reconnecting";

export function GroupDetails({ dictionary, groupId, locale }: GroupDetailsProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [group, setGroup] = useState<OfficeChatGroup | null>(null);
  const [members, setMembers] = useState<OfficeChatGroupMember[]>([]);
  const [messages, setMessages] = useState<OfficeChatMessage[]>([]);
  const [groupForm, setGroupForm] = useState<UpdateGroupPayload>({
    name: "",
    description: "",
    is_private: true,
    is_active: true
  });
  const [memberUsername, setMemberUsername] = useState("");
  const [memberRole, setMemberRole] = useState<GroupRole>("member");
  const [messageBody, setMessageBody] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [liveUpdateStatus, setLiveUpdateStatus] = useState<LiveUpdateStatus>("disconnected");
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

  const currentMembership = currentUser
    ? members.find((member) => member.user_id === currentUser.id)
    : undefined;
  const canManage = Boolean(
    currentUser && (isAdminRole(currentUser.role) || currentMembership?.role === "owner")
  );
  const canModerateMessages = Boolean(
    currentUser &&
      (isAdminRole(currentUser.role) ||
        currentMembership?.role === "owner" ||
        currentMembership?.role === "moderator")
  );

  function formatFileSize(sizeBytes: number) {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const refreshMessages = useCallback(
    async (token: string) => {
      setMessages(await getGroupMessages(token, groupId));
    },
    [groupId]
  );

  async function reload(token: string) {
    const [loadedGroup, loadedMembers, loadedMessages] = await Promise.all([
      getGroup(token, groupId),
      getGroupMembers(token, groupId),
      getGroupMessages(token, groupId)
    ]);
    setGroup(loadedGroup);
    setMembers(loadedMembers);
    setMessages(loadedMessages);
    setGroupForm({
      name: loadedGroup.name,
      description: loadedGroup.description ?? "",
      is_private: loadedGroup.is_private,
      is_active: loadedGroup.is_active
    });
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
        setCurrentUser(await getCurrentUser(accessToken));
        await reload(accessToken);
      } catch {
        clearStoredAccessToken();
        router.replace(`/${locale}/login`);
      } finally {
        setIsLoading(false);
      }
    }

    void loadPage();
  }, [groupId, locale, router]);

  useEffect(() => {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }
    const accessToken = token;

    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    function scheduleReconnect() {
      if (!shouldReconnect) {
        return;
      }
      if (reconnectAttempts >= maxReconnectAttempts) {
        setLiveUpdateStatus("disconnected");
        return;
      }

      reconnectAttempts += 1;
      setLiveUpdateStatus("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    }

    function connect() {
      websocket = new WebSocket(getGroupWebSocketUrl(accessToken, groupId));
      websocket.onopen = () => {
        reconnectAttempts = 0;
        setLiveUpdateStatus("connected");
      };
      websocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as GroupMessageEvent;
          if (payload.type.startsWith("message.")) {
            void refreshMessages(accessToken);
          }
        } catch {
          void refreshMessages(accessToken);
        }
      };
      websocket.onclose = (event) => {
        websocket = null;
        if (event.code === 1008) {
          setLiveUpdateStatus("disconnected");
          return;
        }
        scheduleReconnect();
      };
      websocket.onerror = () => {
        websocket?.close();
      };
    }

    setLiveUpdateStatus("reconnecting");
    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      websocket?.close();
    };
  }, [groupId, locale, refreshMessages, router]);

  async function handleGroupSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setIsSaving(true);
    try {
      await updateGroup(token, groupId, {
        ...groupForm,
        name: groupForm.name.trim(),
        description: groupForm.description?.trim() ? groupForm.description.trim() : null
      });
      await reload(token);
      setSuccess(dictionary.groupDetails.updateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groupDetails.updateError);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setIsAdding(true);
    try {
      await addGroupMember(token, groupId, { username: memberUsername.trim(), role: memberRole });
      setMemberUsername("");
      setMemberRole("member");
      await reload(token);
      setSuccess(dictionary.groupDetails.memberAddSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groupDetails.memberAddError);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleMemberRole(memberId: string, role: GroupRole) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    try {
      await updateGroupMember(token, groupId, memberId, role);
      await reload(token);
      setSuccess(dictionary.groupDetails.memberUpdateSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groupDetails.memberUpdateError);
    }
  }

  async function handleRemoveMember(memberId: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    try {
      await removeGroupMember(token, groupId, memberId);
      await reload(token);
      setSuccess(dictionary.groupDetails.memberRemoveSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.groupDetails.memberRemoveError);
    }
  }

  async function handleRefreshMessages() {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    try {
      await refreshMessages(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.loadError);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    setIsSending(true);
    try {
      if (selectedFile) {
        await sendGroupMessageWithAttachment(token, groupId, messageBody, selectedFile);
      } else {
        await sendGroupMessage(token, groupId, messageBody);
      }
      setMessageBody("");
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.sendSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.sendError);
    } finally {
      setIsSending(false);
    }
  }

  async function handleEditMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = getStoredAccessToken();
    if (!token || !editingMessageId) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    try {
      await editGroupMessage(token, groupId, editingMessageId, editingMessageBody);
      setEditingMessageId(null);
      setEditingMessageBody("");
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.editSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.editError);
    }
  }

  async function handleDeleteMessage(messageId: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    setSuccess("");
    try {
      await deleteGroupMessage(token, groupId, messageId);
      setMessages(await getGroupMessages(token, groupId));
      setSuccess(dictionary.messages.deleteSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.deleteError);
    }
  }

  async function handleDownloadAttachment(downloadUrl: string, filename: string) {
    const token = getStoredAccessToken();
    if (!token) {
      router.replace(`/${locale}/login`);
      return;
    }

    setError("");
    try {
      const blob = await downloadAttachment(token, downloadUrl);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : dictionary.messages.downloadError);
    }
  }

  function updateGroupForm<Key extends keyof UpdateGroupPayload>(key: Key, value: UpdateGroupPayload[Key]) {
    setGroupForm((currentForm) => ({ ...currentForm, [key]: value }));
  }

  return (
    <main className="admin-page">
      <section className="admin-shell" aria-label={dictionary.groupDetails.ariaLabel}>
        <Link className="locale-link" href={`/${locale}/groups`}>
          {dictionary.groupDetails.backToGroups}
        </Link>

        {isLoading ? <p className="muted">{dictionary.groupDetails.loading}</p> : null}
        {group ? (
          <>
            <div className="dashboard-header group-detail-header">
              <div>
                <h1 className="dashboard-title admin-title">{group.name}</h1>
                <p className="admin-current">{group.slug}</p>
                <p className="muted">{group.description ?? dictionary.groups.emptyDescription}</p>
                <div className="group-meta">
                  <span>{group.is_private ? dictionary.groups.private : dictionary.groups.public}</span>
                  <span>{group.is_active ? dictionary.groups.active : dictionary.groups.inactive}</span>
                </div>
              </div>
            </div>

            <div className="admin-grid">
              <div className="admin-side">
                {canManage ? (
                  <>
                    <form className="admin-form" onSubmit={handleGroupSave}>
                      <h2 className="section-title">{dictionary.groupDetails.editGroupTitle}</h2>
                      <label className="field">
                        <span className="field-label">{dictionary.groups.fields.name}</span>
                        <input
                          className="field-input"
                          onChange={(event) => updateGroupForm("name", event.target.value)}
                          required
                          type="text"
                          value={groupForm.name}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">{dictionary.groups.fields.description}</span>
                        <textarea
                          className="field-input textarea-input"
                          onChange={(event) => updateGroupForm("description", event.target.value)}
                          value={groupForm.description ?? ""}
                        />
                      </label>
                      <label className="checkbox-field">
                        <input
                          checked={groupForm.is_private}
                          onChange={(event) => updateGroupForm("is_private", event.target.checked)}
                          type="checkbox"
                        />
                        <span>{dictionary.groups.fields.private}</span>
                      </label>
                      <label className="checkbox-field">
                        <input
                          checked={groupForm.is_active}
                          onChange={(event) => updateGroupForm("is_active", event.target.checked)}
                          type="checkbox"
                        />
                        <span>{dictionary.groups.fields.active}</span>
                      </label>
                      <button className="primary-button" disabled={isSaving} type="submit">
                        {isSaving ? dictionary.groupDetails.saving : dictionary.groupDetails.saveGroup}
                      </button>
                    </form>

                    <form className="admin-form edit-panel" onSubmit={handleAddMember}>
                      <h2 className="section-title">{dictionary.groupDetails.addMemberTitle}</h2>
                      <label className="field">
                        <span className="field-label">{dictionary.groupDetails.username}</span>
                        <input
                          className="field-input"
                          onChange={(event) => setMemberUsername(event.target.value)}
                          required
                          type="text"
                          value={memberUsername}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">{dictionary.groupDetails.groupRole}</span>
                        <select
                          className="field-input"
                          onChange={(event) => setMemberRole(event.target.value as GroupRole)}
                          value={memberRole}
                        >
                          {groupRoles.map((role) => (
                            <option key={role} value={role}>
                              {dictionary.groupDetails.roles[role]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="primary-button" disabled={isAdding} type="submit">
                        {isAdding ? dictionary.groupDetails.adding : dictionary.groupDetails.addMember}
                      </button>
                    </form>
                  </>
                ) : (
                  <p className="muted">{dictionary.groupDetails.readOnlyNote}</p>
                )}

                {success ? <p className="form-success">{success}</p> : null}
                {error ? <p className="form-error">{error}</p> : null}
              </div>

              <div className="admin-table-wrap">
                <h2 className="section-title">{dictionary.groupDetails.membersTitle}</h2>
                <div className="table-scroll">
                  <table className="users-table">
                    <thead>
                      <tr>
                        <th>{dictionary.groupDetails.columns.displayName}</th>
                        <th>{dictionary.groupDetails.columns.username}</th>
                        <th>{dictionary.groupDetails.columns.globalRole}</th>
                        <th>{dictionary.groupDetails.columns.groupRole}</th>
                        <th>{dictionary.groupDetails.columns.joinedAt}</th>
                        {canManage ? <th>{dictionary.groupDetails.columns.actions}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>{member.user.display_name}</td>
                          <td>{member.user.username}</td>
                          <td>{member.user.role}</td>
                          <td>
                            {canManage ? (
                              <select
                                className="table-select"
                                onChange={(event) =>
                                  void handleMemberRole(member.id, event.target.value as GroupRole)
                                }
                                value={member.role}
                              >
                                {groupRoles.map((role) => (
                                  <option key={role} value={role}>
                                    {dictionary.groupDetails.roles[role]}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              dictionary.groupDetails.roles[member.role]
                            )}
                          </td>
                          <td>{dateFormatter.format(new Date(member.joined_at))}</td>
                          {canManage ? (
                            <td>
                              <button
                                className="table-action"
                                onClick={() => void handleRemoveMember(member.id)}
                                type="button"
                              >
                                {dictionary.groupDetails.removeMember}
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <section className="messages-panel" aria-label={dictionary.messages.ariaLabel}>
              <div className="dashboard-header">
                <div>
                  <h2 className="section-title">{dictionary.messages.title}</h2>
                  <p className={`live-status live-status-${liveUpdateStatus}`}>
                    {dictionary.messages.liveStatusLabel}{" "}
                    {dictionary.messages.liveStatuses[liveUpdateStatus]}
                  </p>
                </div>
                <button className="secondary-link" onClick={() => void handleRefreshMessages()} type="button">
                  {dictionary.messages.refresh}
                </button>
              </div>

              <div className="messages-list">
                {messages.map((message) => {
                  const canEdit = currentUser?.id === message.sender_user_id && !message.is_deleted;
                  const canDelete = (canEdit || canModerateMessages) && !message.is_deleted;
                  return (
                    <article className="message-item" key={message.id}>
                      <div className="message-meta">
                        <strong>{message.sender.display_name}</strong>
                        <span>{message.sender.username}</span>
                        <span>{dateFormatter.format(new Date(message.created_at))}</span>
                        {message.edited_at ? <span>{dictionary.messages.edited}</span> : null}
                      </div>
                      {editingMessageId === message.id ? (
                        <form className="message-edit-form" onSubmit={handleEditMessage}>
                          <textarea
                            className="field-input textarea-input"
                            onChange={(event) => setEditingMessageBody(event.target.value)}
                            required
                            value={editingMessageBody}
                          />
                          <div className="actions">
                            <button className="primary-button" type="submit">
                              {dictionary.messages.saveEdit}
                            </button>
                            <button
                              className="secondary-link"
                              onClick={() => {
                                setEditingMessageId(null);
                                setEditingMessageBody("");
                              }}
                              type="button"
                            >
                              {dictionary.messages.cancelEdit}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <p className={message.is_deleted ? "message-body deleted-message" : "message-body"}>
                          {message.body}
                        </p>
                      )}
                      {message.attachments.length > 0 ? (
                        <div className="attachments-list">
                          {message.attachments.map((attachment) => (
                            <button
                              className="attachment-button"
                              key={attachment.id}
                              onClick={() =>
                                void handleDownloadAttachment(
                                  attachment.download_url,
                                  attachment.original_filename
                                )
                              }
                              type="button"
                            >
                              <span>{attachment.original_filename}</span>
                              <span>{formatFileSize(attachment.size_bytes)}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {!message.is_deleted ? (
                        <div className="message-actions">
                          {canEdit ? (
                            <button
                              className="table-action"
                              onClick={() => {
                                setEditingMessageId(message.id);
                                setEditingMessageBody(message.body);
                              }}
                              type="button"
                            >
                              {dictionary.messages.edit}
                            </button>
                          ) : null}
                          {canDelete ? (
                            <button
                              className="table-action"
                              onClick={() => void handleDeleteMessage(message.id)}
                              type="button"
                            >
                              {dictionary.messages.delete}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>

              <form className="admin-form message-compose" onSubmit={handleSendMessage}>
                <label className="field">
                  <span className="field-label">{dictionary.messages.body}</span>
                  <textarea
                    className="field-input textarea-input"
                    onChange={(event) => setMessageBody(event.target.value)}
                    required={!selectedFile}
                    value={messageBody}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{dictionary.messages.attachment}</span>
                  <input
                    className="field-input file-input"
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                    ref={fileInputRef}
                    type="file"
                  />
                </label>
                <button className="primary-button" disabled={isSending} type="submit">
                  {isSending
                    ? dictionary.messages.sending
                    : selectedFile
                      ? dictionary.messages.sendWithAttachment
                      : dictionary.messages.send}
                </button>
              </form>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
