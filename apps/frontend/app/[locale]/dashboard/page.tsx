import { notFound } from "next/navigation";

import { Dashboard } from "../../../components/Dashboard";
import { getDictionary, isLocale } from "../../../lib/i18n";

export default async function DashboardPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <Dashboard dictionary={getDictionary(locale)} locale={locale} />;
}
