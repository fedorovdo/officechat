"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { fetchUserAvatar, getStoredAccessToken } from "../lib/api";

type AvatarUser = {
  id?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string | null;
};

type UserAvatarProps = {
  user: AvatarUser;
  size?: number;
  className?: string;
  title?: string;
};

const avatarObjectUrlCache = new Map<string, Promise<string>>();

function getInitials(user: AvatarUser) {
  const source = user.display_name?.trim() || user.username?.trim() || "OC";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "OC").toUpperCase();
}

function getAvatarHue(user: AvatarUser) {
  const source = user.id || user.username || user.display_name || "officechat";
  let hash = 0;
  for (const character of source) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 360;
}

function loadAvatarObjectUrl(avatarUrl: string) {
  const cached = avatarObjectUrlCache.get(avatarUrl);
  if (cached) {
    return cached;
  }
  const token = getStoredAccessToken();
  if (!token) {
    return Promise.reject(new Error("Authentication required"));
  }
  const pending = fetchUserAvatar(token, avatarUrl)
    .then((blob) => URL.createObjectURL(blob))
    .catch((error) => {
      avatarObjectUrlCache.delete(avatarUrl);
      throw error;
    });
  avatarObjectUrlCache.set(avatarUrl, pending);
  return pending;
}

export function UserAvatar({ user, size = 40, className = "", title }: UserAvatarProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const initials = useMemo(() => getInitials(user), [user]);
  const style = {
    "--avatar-size": `${size}px`,
    "--avatar-hue": getAvatarHue(user)
  } as CSSProperties;

  useEffect(() => {
    let isCurrent = true;
    setImageUrl(null);
    setImageFailed(false);
    if (!user.avatar_url) {
      return () => {
        isCurrent = false;
      };
    }
    void loadAvatarObjectUrl(user.avatar_url)
      .then((url) => {
        if (isCurrent) setImageUrl(url);
      })
      .catch(() => {
        if (isCurrent) setImageFailed(true);
      });
    return () => {
      isCurrent = false;
    };
  }, [user.avatar_url]);

  return (
    <span
      aria-label={title || user.display_name || user.username}
      className={["user-avatar", className].filter(Boolean).join(" ")}
      role="img"
      style={style}
      title={title || user.display_name || user.username}
    >
      {imageUrl && !imageFailed ? (
        <img alt="" onError={() => setImageFailed(true)} src={imageUrl} />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
