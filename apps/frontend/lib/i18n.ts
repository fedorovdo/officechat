import en from "../dictionaries/en.json";
import ru from "../dictionaries/ru.json";

export const locales = ["ru", "en"] as const;
export const defaultLocale = "ru";

export type Locale = (typeof locales)[number];
export type Dictionary = typeof ru;

const dictionaries: Record<Locale, Dictionary> = {
  en,
  ru
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.includes(value as Locale);
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
