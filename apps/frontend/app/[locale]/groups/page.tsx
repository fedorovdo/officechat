import { notFound } from "next/navigation";

import { Groups } from "../../../components/Groups";
import { getDictionary, isLocale } from "../../../lib/i18n";

export default async function GroupsPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <Groups dictionary={getDictionary(locale)} locale={locale} />;
}
