"use client";

import Link from "next/link";
import { useMemo } from "react";

import { BrandLogo } from "../../components/Brand";
import { getLocalizedBrand } from "../../lib/brand";
import type { Locale } from "../../lib/i18n";

export default function LocaleNotFoundPage() {
  const locale = useMemo<Locale>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/en")) {
      return "en";
    }
    return "ru";
  }, []);
  const isEnglish = locale === "en";
  const localizedBrand = getLocalizedBrand(locale);

  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card" role="alert">
        <BrandLogo tagline={localizedBrand.tagline} />
        <h1>{isEnglish ? "Page not found" : "Страница не найдена"}</h1>
        <p>{isEnglish ? "The requested OfficeChat page is unavailable." : "Запрошенная страница OfficeChat недоступна."}</p>
        <div className="form-actions">
          <Link className="primary-button" href={`/${locale}/app`}>
            {isEnglish ? "To app" : "В приложение"}
          </Link>
          <Link className="secondary-link" href={`/${locale}/login`}>
            {isEnglish ? "To login page" : "На страницу входа"}
          </Link>
        </div>
      </section>
    </main>
  );
}
