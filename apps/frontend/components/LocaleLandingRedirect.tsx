"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { getStoredAccessToken } from "../lib/session";
import type { Locale } from "../lib/i18n";

type LocaleLandingRedirectProps = {
  locale: Locale;
};

export function getLocalizedLandingTarget(locale: Locale) {
  return getStoredAccessToken() ? `/${locale}/app` : `/${locale}/login`;
}

export function LocaleLandingRedirect({ locale }: LocaleLandingRedirectProps) {
  const router = useRouter();

  useEffect(() => {
    router.replace(getLocalizedLandingTarget(locale));
  }, [locale, router]);

  return null;
}
