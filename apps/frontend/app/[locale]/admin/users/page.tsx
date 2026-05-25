import { notFound } from "next/navigation";

import { AdminUsers } from "../../../../components/AdminUsers";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function AdminUsersPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <AdminUsers dictionary={getDictionary(locale)} locale={locale} />;
}
