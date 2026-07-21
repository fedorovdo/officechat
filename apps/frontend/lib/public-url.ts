function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizePublicPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

export function getPublicOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
    return trimTrailingSlashes(window.location.origin);
  }

  const configuredOrigin =
    process.env.NEXT_PUBLIC_FRONTEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_BACKEND_URL?.trim() ||
    "";
  return trimTrailingSlashes(configuredOrigin);
}

export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  return trimTrailingSlashes(
    process.env.NEXT_PUBLIC_BACKEND_URL?.trim() ||
      process.env.NEXT_PUBLIC_FRONTEND_URL?.trim() ||
      ""
  );
}

export function buildApiUrl(path: string): string {
  return `${getApiBaseUrl()}${normalizePublicPath(path)}`;
}

export function buildPublicUrl(path: string, origin = getPublicOrigin()): string {
  return `${trimTrailingSlashes(origin)}${normalizePublicPath(path)}`;
}

export function buildWebSocketUrl(path: string, token: string, origin = getPublicOrigin()): string {
  if (!origin) throw new Error("A browser or configured public origin is required for WebSocket URLs");
  const url = new URL(normalizePublicPath(path), `${trimTrailingSlashes(origin)}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = new URLSearchParams({ token }).toString();
  return url.toString();
}

export function getApiDocsHref(): string {
  return normalizePublicPath("docs");
}

export function getIncomingBotWebhookUrl(token: string, origin?: string): string {
  return buildPublicUrl(`/api/bots/incoming/${encodeURIComponent(token)}`, origin);
}
