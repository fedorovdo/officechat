import Link from "next/link";

import { locales, type Dictionary, type Locale } from "../lib/i18n";

type LandingProps = {
  dictionary: Dictionary;
  locale: Locale;
};

export function Landing({ dictionary, locale }: LandingProps) {
  return (
    <main className="page">
      <section className="shell" aria-label={dictionary.app.ariaLabel}>
        <div className="hero">
          <div>
            <nav className="locale-switcher" aria-label={dictionary.language.switcherLabel}>
              {locales.map((availableLocale) => (
                <Link
                  aria-current={availableLocale === locale}
                  className="locale-link"
                  href={`/${availableLocale}`}
                  key={availableLocale}
                >
                  {dictionary.language.options[availableLocale]}
                </Link>
              ))}
            </nav>

            <p className="eyebrow">{dictionary.app.tagline}</p>
            <h1 className="title">{dictionary.app.name}</h1>
            <p className="description">{dictionary.app.description}</p>
          </div>

          <div className="actions">
            <button className="primary-button" disabled type="button">
              {dictionary.actions.login}
            </button>
            <Link className="secondary-link" href={dictionary.links.docsHref}>
              {dictionary.actions.apiDocs}
            </Link>
          </div>
        </div>

        <aside className="status-panel" aria-label={dictionary.status.ariaLabel}>
          <div>
            <h2 className="status-title">{dictionary.status.title}</h2>
            <div className="status-list">
              <div className="status-row">
                <span className="status-label">{dictionary.status.backend}</span>
                <span className="status-value">{dictionary.status.placeholder}</span>
              </div>
              <div className="status-row">
                <span className="status-label">{dictionary.status.database}</span>
                <span className="status-value">{dictionary.status.placeholder}</span>
              </div>
              <div className="status-row">
                <span className="status-label">{dictionary.status.cache}</span>
                <span className="status-value">{dictionary.status.placeholder}</span>
              </div>
            </div>
          </div>

          <p className="note">{dictionary.status.note}</p>
        </aside>
      </section>
    </main>
  );
}
