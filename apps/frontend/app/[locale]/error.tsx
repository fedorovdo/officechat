"use client";

import { useEffect } from "react";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function LocaleErrorPage({ error, reset }: ErrorPageProps) {
  const isEnglish = typeof window !== "undefined" && window.location.pathname.startsWith("/en");

  useEffect(() => {
    console.error("OfficeChat frontend boundary caught an error", { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card" role="alert">
        <h1>{isEnglish ? "Something went wrong." : "Произошла ошибка."}</h1>
        <p>{isEnglish ? "Try refreshing the page." : "Попробуйте обновить страницу."}</p>
        {error.digest ? (
          <p className="muted-text">Request ID: {error.digest}</p>
        ) : null}
        <div className="form-actions">
          <button className="primary-button" onClick={reset} type="button">
            {isEnglish ? "Retry" : "Повторить"}
          </button>
          <button className="secondary-button" onClick={() => window.location.reload()} type="button">
            {isEnglish ? "Reload" : "Обновить"}
          </button>
        </div>
      </section>
    </main>
  );
}
