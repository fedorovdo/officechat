import { notFound } from "next/navigation";

import { Landing } from "../../components/Landing";
import { getDictionary, isLocale } from "../../lib/i18n";

export default async function LocalePage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  const dictionary = getDictionary(locale);

  return <Landing dictionary={dictionary} locale={locale} />;
}
