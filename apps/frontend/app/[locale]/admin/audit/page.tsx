import { notFound } from "next/navigation";

import { AdminAudit } from "../../../../components/AdminAudit";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function AdminAuditPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) notFound();
  return <AdminAudit dictionary={getDictionary(rawLocale)} locale={rawLocale} />;
}
