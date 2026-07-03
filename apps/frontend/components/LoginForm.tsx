"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Dictionary, Locale } from "../lib/i18n";
import { getSafeLoginNext, storeAccessToken } from "../lib/session";

type LoginFormProps = {
  dictionary: Dictionary;
  locale: Locale;
};

export function LoginForm({ dictionary, locale }: LoginFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("reason");
    if (reason === "session-expired") {
      setNotice(dictionary.session.expired);
    } else if (reason === "sign-in-required") {
      setNotice(dictionary.session.signInRequired);
    }
  }, [dictionary.session.expired, dictionary.session.signInRequired]);

  function handleLanguageChange(nextLocale: Locale) {
    router.push(`/${nextLocale}/login`);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });

      if (!response.ok) {
        setError(dictionary.login.invalidCredentials);
        return;
      }

      const data = (await response.json()) as { access_token: string };
      // TODO: Move production auth storage to secure cookies or a stronger session mechanism.
      storeAccessToken(data.access_token);
      window.location.replace(getSafeLoginNext() ?? `/${locale}/app`);
    } catch {
      setError(dictionary.login.networkError);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-label={dictionary.login.ariaLabel}>
        <Link className="locale-link" href={`/${locale}`}>
          {dictionary.login.back}
        </Link>
        <h1 className="auth-title">{dictionary.login.title}</h1>
        <p className="auth-description">{dictionary.login.description}</p>
        {notice ? <p className="form-success">{notice}</p> : null}

        <label className="field auth-language-field">
          <span className="field-label">{dictionary.login.language}</span>
          <select
            className="field-input"
            onChange={(event) => handleLanguageChange(event.target.value as Locale)}
            value={locale}
          >
            <option value="ru">RU</option>
            <option value="en">EN</option>
          </select>
        </label>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field-label">{dictionary.login.username}</span>
            <input
              autoComplete="username"
              className="field-input"
              onChange={(event) => setUsername(event.target.value)}
              required
              type="text"
              value={username}
            />
          </label>

          <label className="field">
            <span className="field-label">{dictionary.login.password}</span>
            <input
              autoComplete="current-password"
              className="field-input"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? dictionary.login.submitting : dictionary.login.submit}
          </button>
        </form>
      </section>
    </main>
  );
}
