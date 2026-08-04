import { notFound } from "next/navigation";

import { AdminBackups } from "../../../../components/AdminBackups";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function AdminBackupsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <AdminBackups dictionary={getDictionary(locale)} locale={locale} />;
}
