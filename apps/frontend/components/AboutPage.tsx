"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { BrandLogo } from "./Brand";
import { getLocalizedBrand, officeChatBrand } from "../lib/brand";
import type { Dictionary, Locale } from "../lib/i18n";
import { buildApiUrl } from "../lib/public-url";

type AboutPageProps = {
  dictionary: Dictionary;
  locale: Locale;
};

type HealthStatus = {
  status: "idle" | "loading" | "ok" | "unavailable";
  service: string;
  version: string;
  product?: string;
};

const initialHealth: HealthStatus = {
  status: "idle",
  service: "",
  version: ""
};

function isSafeExternalUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!isSafeExternalUrl(href)) return null;
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

export function AboutPage({ dictionary, locale }: AboutPageProps) {
  const about = dictionary.about;
  const localizedBrand = getLocalizedBrand(locale);
  const [frontendHealth, setFrontendHealth] = useState<HealthStatus>(initialHealth);
  const [backendHealth, setBackendHealth] = useState<HealthStatus>(initialHealth);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);

  const features = useMemo(
    () => [
      about.features.groupChats,
      about.features.directChats,
      about.features.discussions,
      about.features.attachments,
      about.features.notifications,
      about.features.announcements,
      about.features.calendar,
      about.features.search,
      about.features.pins,
      about.features.adminAudit,
      about.features.selfHosted
    ],
    [about.features]
  );

  async function loadHealth() {
    setFrontendHealth((current) => ({ ...current, status: "loading" }));
    setBackendHealth((current) => ({ ...current, status: "loading" }));

    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("frontend health unavailable");
      const data = (await response.json()) as Partial<HealthStatus>;
      setFrontendHealth({
        status: "ok",
        service: data.service ?? "officechat-frontend",
        version: data.version ?? officeChatBrand.version
      });
    } catch {
      setFrontendHealth({ ...initialHealth, status: "unavailable" });
    }

    try {
      const response = await fetch(buildApiUrl("/health"), { cache: "no-store" });
      if (!response.ok) throw new Error("backend health unavailable");
      const data = (await response.json()) as Partial<HealthStatus>;
      setBackendHealth({
        status: "ok",
        service: data.service ?? "officechat-backend",
        version: data.version ?? "",
        product: data.product
      });
    } catch {
      setBackendHealth({ ...initialHealth, status: "unavailable" });
    }
  }

  useEffect(() => {
    void loadHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function serviceLabel(status: HealthStatus) {
    if (status.status === "loading") return about.statusLoading;
    if (status.status === "ok") return about.statusWorking;
    if (status.status === "unavailable") return about.statusUnavailable;
    return about.statusUnknown;
  }

  return (
    <main className="about-page">
      <section className="about-shell" aria-label={about.title}>
        <div className="about-hero">
          <BrandLogo tagline={localizedBrand.tagline} />
          <div>
            <p className="eyebrow">{about.officeChat}</p>
            <h1 className="dashboard-title">{about.title}</h1>
            <p className="about-description">{localizedBrand.description}</p>
          </div>
          <div className="about-actions">
            <Link className="primary-button" href={`/${locale}/app`}>
              {about.toApp}
            </Link>
            <Link className="secondary-link" href={`/${locale}/login`}>
              {about.toLogin}
            </Link>
          </div>
        </div>

        <div className="about-grid">
          <section className="about-card">
            <h2>{about.version}</h2>
            <dl className="about-facts">
              <div>
                <dt>{about.applicationVersion}</dt>
                <dd>{officeChatBrand.version || "development"}</dd>
              </div>
              <div>
                <dt>{about.language}</dt>
                <dd>{locale.toUpperCase()}</dd>
              </div>
              <div>
                <dt>{about.license}</dt>
                <dd>Apache-2.0</dd>
              </div>
            </dl>
          </section>

          <section className="about-card">
            <h2>{about.featuresTitle}</h2>
            <ul className="about-feature-list">
              {features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          </section>

          <section className="about-card">
            <div className="about-card-header">
              <h2>{about.serviceStatus}</h2>
              <button className="table-action" onClick={() => void loadHealth()} type="button">
                {about.refreshStatus}
              </button>
            </div>
            <div className="about-service-grid">
              <article className={`about-service-card about-service-${frontendHealth.status}`}>
                <strong>{about.frontend}</strong>
                <span>{serviceLabel(frontendHealth)}</span>
                {frontendHealth.version ? <small>{frontendHealth.version}</small> : null}
              </article>
              <article className={`about-service-card about-service-${backendHealth.status}`}>
                <strong>{about.backend}</strong>
                <span>{serviceLabel(backendHealth)}</span>
                {backendHealth.version ? <small>{backendHealth.version}</small> : null}
              </article>
            </div>
            {frontendHealth.status === "unavailable" || backendHealth.status === "unavailable" ? (
              <p className="note">{about.statusUnavailableMessage}</p>
            ) : null}
          </section>

          <section className="about-card">
            <h2>{about.developer}</h2>
            <dl className="about-facts">
              <div>
                <dt>{about.author}</dt>
                <dd>{officeChatBrand.authorName}</dd>
              </div>
              <div>
                <dt>{about.links}</dt>
                <dd className="about-links">
                  <ExternalLink href={officeChatBrand.authorWebsite}>{about.authorWebsite}</ExternalLink>
                  <ExternalLink href={officeChatBrand.repositoryUrl}>{about.repository}</ExternalLink>
                  {officeChatBrand.projectWebsite ? (
                    <ExternalLink href={officeChatBrand.projectWebsite}>{about.projectWebsite}</ExternalLink>
                  ) : null}
                </dd>
              </div>
              {officeChatBrand.supportEmail ? (
                <div>
                  <dt>{about.support}</dt>
                  <dd>
                    <a href={`mailto:${officeChatBrand.supportEmail}`}>{officeChatBrand.supportEmail}</a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        </div>

        <section className="about-card about-technical">
          <button
            aria-expanded={showTechnicalDetails}
            className="secondary-link"
            onClick={() => setShowTechnicalDetails((current) => !current)}
            type="button"
          >
            {about.technicalDetails}
          </button>
          {showTechnicalDetails ? (
            <dl className="about-facts">
              <div>
                <dt>{about.frontendVersion}</dt>
                <dd>{officeChatBrand.version || "development"}</dd>
              </div>
              <div>
                <dt>{about.backendVersion}</dt>
                <dd>{backendHealth.version || about.statusUnknown}</dd>
              </div>
              {officeChatBrand.buildSha ? (
                <div>
                  <dt>{about.buildSha}</dt>
                  <dd>{officeChatBrand.buildSha}</dd>
                </div>
              ) : null}
              {officeChatBrand.buildDate ? (
                <div>
                  <dt>{about.buildDate}</dt>
                  <dd>{officeChatBrand.buildDate}</dd>
                </div>
              ) : null}
              <div>
                <dt>{about.frontendFramework}</dt>
                <dd>Next.js</dd>
              </div>
            </dl>
          ) : null}
        </section>

        <footer className="about-footer">
          {officeChatBrand.productName} · {officeChatBrand.version || "development"} · ©{" "}
          {officeChatBrand.copyrightYear} {officeChatBrand.authorName}
        </footer>
      </section>
    </main>
  );
}
