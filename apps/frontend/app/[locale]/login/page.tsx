import { notFound } from "next/navigation";

import { LoginForm } from "../../../components/LoginForm";
import { getDictionary, isLocale } from "../../../lib/i18n";

export default async function LoginPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <LoginForm dictionary={getDictionary(locale)} locale={locale} />;
}
