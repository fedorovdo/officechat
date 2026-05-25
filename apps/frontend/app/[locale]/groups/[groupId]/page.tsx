import { notFound } from "next/navigation";

import { GroupDetails } from "../../../../components/GroupDetails";
import { getDictionary, isLocale } from "../../../../lib/i18n";

export default async function GroupDetailsPage({
  params
}: Readonly<{
  params: Promise<{ locale: string; groupId: string }>;
}>) {
  const { locale, groupId } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <GroupDetails dictionary={getDictionary(locale)} groupId={groupId} locale={locale} />;
}
