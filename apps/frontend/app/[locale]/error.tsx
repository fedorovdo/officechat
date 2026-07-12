"use client";

import { useEffect } from "react";
import Link from "next/link";

import { BrandLogo } from "../../components/Brand";
import { getLocalizedBrand } from "../../lib/brand";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function LocaleErrorPage({ error, reset }: ErrorPageProps) {
  const isEnglish = typeof window !== "undefined" && window.location.pathname.startsWith("/en");
  const locale = isEnglish ? "en" : "ru";
  const localizedBrand = getLocalizedBrand(locale);

  useEffect(() => {
    console.error("OfficeChat frontend boundary caught an error", { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card" role="alert">
        <BrandLogo tagline={localizedBrand.tagline} />
        <h1>{isEnglish ? "Something went wrong." : "Произошла ошибка."}</h1>
        <p>{isEnglish ? "Try refreshing the page." : "Попробуйте обновить страницу."}</p>
        {error.digest ? (
          <p className="muted-text">Request ID: {error.digest}</p>
        ) : null}
        <div className="form-actions">
          <button className="primary-button" onClick={reset} type="button">
            {isEnglish ? "Retry" : "Повторить"}
          </button>
          <Link className="secondary-link" href={`/${locale}/app`}>
            {isEnglish ? "To app" : "В приложение"}
          </Link>
        </div>
      </section>
    </main>
  );
}
