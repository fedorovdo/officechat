import { notFound } from "next/navigation";

import { AdminStorage } from "../../../../components/AdminStorage";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function AdminStoragePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) notFound();
  return <AdminStorage dictionary={getDictionary(rawLocale)} locale={rawLocale} />;
}
