"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  addGroupMember,
  clearStoredAccessToken,
  getCurrentUser,
  getGroup,
  getGroupMembers,
  getStoredAccessToken,
  isAdminRole,
  removeGroupMember,
  updateGroup,
  updateGroupMember,
  type GroupRole,
  type OfficeChatGroup,
  type OfficeChatGroupMember,
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

export function GroupDetails({ dictionary, groupId, locale }: GroupDetailsProps) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<OfficeChatUser | null>(null);
  const [group, setGroup] = useState<OfficeChatGroup | null>(null);
  const [members, setMembers] = useState<OfficeChatGroupMember[]>([]);
  const [groupForm, setGroupForm] = useState<UpdateGroupPayload>({
    name: "",
    description: "",
    is_private: true,
    is_active: true
  });
  const [memberUsername, setMemberUsername] = useState("");
  const [memberRole, setMemberRole] = useState<GroupRole>("member");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
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

  async function reload(token: string) {
    const [loadedGroup, loadedMembers] = await Promise.all([
      getGroup(token, groupId),
      getGroupMembers(token, groupId)
    ]);
    setGroup(loadedGroup);
    setMembers(loadedMembers);
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
          </>
        ) : null}
      </section>
    </main>
  );
}
