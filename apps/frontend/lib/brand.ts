import type { Locale } from "./i18n";

function safeHttpUrl(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function optionalSafeHttpUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export const officeChatVersion = process.env.NEXT_PUBLIC_OFFICECHAT_VERSION ?? "0.1.0-rc2";
export const officeChatBuildSha = process.env.NEXT_PUBLIC_OFFICECHAT_BUILD_SHA ?? "";
export const officeChatBuildDate = process.env.NEXT_PUBLIC_OFFICECHAT_BUILD_DATE ?? "";

export const officeChatBrand = {
  productName: process.env.NEXT_PUBLIC_OFFICECHAT_PRODUCT_NAME ?? "OfficeChat",
  shortName: "OC",
  taglineRu: "Корпоративный чат",
  taglineEn: "Corporate messenger",
  descriptionRu:
    "Локальный корпоративный чат для сообщений, объявлений, уведомлений и событий.",
  descriptionEn:
    "A self-hosted corporate messenger for chats, announcements, notifications and events.",
  organizationName: process.env.NEXT_PUBLIC_OFFICECHAT_ORGANIZATION_NAME ?? "",
  authorName: process.env.NEXT_PUBLIC_OFFICECHAT_AUTHOR_NAME ?? "Dmitrii Fedorov",
  authorWebsite: safeHttpUrl(
    process.env.NEXT_PUBLIC_OFFICECHAT_AUTHOR_URL,
    "https://simplyadmin.org/"
  ),
  repositoryUrl: safeHttpUrl(
    process.env.NEXT_PUBLIC_OFFICECHAT_REPOSITORY_URL,
    "https://github.com/fedorovdo/officechat"
  ),
  supportEmail: process.env.NEXT_PUBLIC_OFFICECHAT_SUPPORT_EMAIL ?? "",
  projectWebsite: optionalSafeHttpUrl(process.env.NEXT_PUBLIC_OFFICECHAT_PROJECT_URL),
  copyrightYear: new Date().getFullYear(),
  version: officeChatVersion,
  buildSha: officeChatBuildSha ? officeChatBuildSha.slice(0, 12) : "",
  buildDate: officeChatBuildDate
} as const;

export function getLocalizedBrand(locale: Locale) {
  return {
    tagline: locale === "ru" ? officeChatBrand.taglineRu : officeChatBrand.taglineEn,
    description: locale === "ru" ? officeChatBrand.descriptionRu : officeChatBrand.descriptionEn,
    title:
      locale === "ru"
        ? `${officeChatBrand.productName} — корпоративный чат`
        : `${officeChatBrand.productName} — corporate messenger`
  };
}
