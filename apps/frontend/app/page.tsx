import { redirect } from "next/navigation";

import { defaultLocale, isLocale } from "../lib/i18n";

export default function IndexPage() {
  const locale = process.env.NEXT_PUBLIC_DEFAULT_LOCALE;
  redirect(`/${isLocale(locale) ? locale : defaultLocale}`);
}
