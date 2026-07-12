import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AboutPage } from "../../../components/AboutPage";
import { getLocalizedBrand, officeChatBrand } from "../../../lib/brand";
import { getDictionary, isLocale } from "../../../lib/i18n";

export async function generateMetadata({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    return {};
  }
  const localizedBrand = getLocalizedBrand(locale);
  return {
    title: locale === "ru" ? "О программе" : "About",
    description: localizedBrand.description,
    openGraph: {
      title: localizedBrand.title,
      description: localizedBrand.description,
      siteName: officeChatBrand.productName
    }
  };
}

export default async function LocalizedAboutPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!isLocale(locale)) {
    notFound();
  }

  return <AboutPage dictionary={getDictionary(locale)} locale={locale} />;
}

