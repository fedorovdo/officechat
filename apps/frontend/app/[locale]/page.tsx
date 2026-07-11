import { notFound } from "next/navigation";

import { LocaleLandingRedirect } from "../../components/LocaleLandingRedirect";
import { isLocale } from "../../lib/i18n";

export default async function LocalePage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <LocaleLandingRedirect locale={locale} />;
}
