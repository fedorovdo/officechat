import { notFound } from "next/navigation";

import { AdminBots } from "../../../../components/AdminBots";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function AdminBotsPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <AdminBots dictionary={getDictionary(locale)} locale={locale} />;
}
