const DEVELOPMENT_PUBLIC_ORIGIN = "http://localhost:3100";

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
    DEVELOPMENT_PUBLIC_ORIGIN;
  return trimTrailingSlashes(configuredOrigin);
}

export function buildPublicUrl(path: string, origin = getPublicOrigin()): string {
  return `${trimTrailingSlashes(origin)}${normalizePublicPath(path)}`;
}

export function getApiDocsHref(): string {
  return normalizePublicPath("docs");
}

export function getIncomingBotWebhookUrl(token: string, origin?: string): string {
  return buildPublicUrl(`/api/bots/incoming/${encodeURIComponent(token)}`, origin);
}
