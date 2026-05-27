import { notFound } from "next/navigation";

import { UserAppShell } from "../../../components/UserAppShell";
import { getDictionary, isLocale } from "../../../lib/i18n";

export default async function AppPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <UserAppShell dictionary={getDictionary(locale)} locale={locale} />;
}
