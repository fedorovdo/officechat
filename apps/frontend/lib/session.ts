export const ACCESS_TOKEN_KEY = "officechat.access_token";
export const AUTHENTICATION_EXPIRED_EVENT = "officechat:authentication-expired";

export type AuthenticationEndReason = "expired" | "invalid" | "missing" | "logout";

type AuthenticationExpiredDetail = {
  reason: AuthenticationEndReason;
};

let authenticationEndStarted = false;

function getLocaleFromPathname(pathname = window.location.pathname): "ru" | "en" {
  const locale = pathname.split("/").filter(Boolean)[0];
  return locale === "en" ? "en" : "ru";
}

function isSafeInternalPath(path: string | null): path is string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return false;
  try {
    const parsed = new URL(path, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      /^\/(ru|en)\/(app|dashboard|groups(?:\/|$)|admin(?:\/|$))/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function tokenHasUsableExpiration(token: string): boolean {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return false;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function clearStoredAccessToken() {
  if (typeof window !== "undefined") localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function storeAccessToken(token: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
  authenticationEndStarted = false;
}

export function resetAuthenticationGuard() {
  authenticationEndStarted = false;
}

export function getStoredAccessToken() {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (!token) return null;
  if (!tokenHasUsableExpiration(token)) {
    expireAuthentication("invalid");
    return null;
  }
  return token;
}

export function getSafeLoginNext(): string | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  return isSafeInternalPath(next) ? next : null;
}

export function expireAuthentication(reason: AuthenticationEndReason = "expired", locale?: "ru" | "en") {
  if (typeof window === "undefined" || authenticationEndStarted) return;
  authenticationEndStarted = true;
  clearStoredAccessToken();
  window.dispatchEvent(
    new CustomEvent<AuthenticationExpiredDetail>(AUTHENTICATION_EXPIRED_EVENT, { detail: { reason } })
  );

  const selectedLocale = locale ?? getLocaleFromPathname();
  const loginUrl = new URL(`/${selectedLocale}/login`, window.location.origin);
  if (reason !== "logout") {
    loginUrl.searchParams.set("reason", reason === "missing" ? "sign-in-required" : "session-expired");
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (isSafeInternalPath(currentPath) && !window.location.pathname.endsWith("/login")) {
      loginUrl.searchParams.set("next", currentPath);
    }
  }
  window.location.replace(`${loginUrl.pathname}${loginUrl.search}`);
}

export function requireStoredAccessToken(locale: "ru" | "en") {
  const token = getStoredAccessToken();
  if (!token && !authenticationEndStarted) expireAuthentication("missing", locale);
  return token;
}

export function onAuthenticationExpired(listener: (reason: AuthenticationEndReason) => void) {
  const handler = (event: Event) => {
    listener((event as CustomEvent<AuthenticationExpiredDetail>).detail.reason);
  };
  window.addEventListener(AUTHENTICATION_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(AUTHENTICATION_EXPIRED_EVENT, handler);
}

export async function logoutSession(locale: "ru" | "en", backendUrl: string) {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (token) {
    void fetch(`${backendUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true
      }).catch(() => undefined);
  }
  // Logout is deliberately local-first and must succeed while the backend is unavailable.
  expireAuthentication("logout", locale);
}
