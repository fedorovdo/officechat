import { BrandLogo } from "../components/Brand";
import { getLocalizedBrand } from "../lib/brand";

export default function LoadingPage() {
  const localizedBrand = getLocalizedBrand("en");

  return (
    <main className="error-boundary-page">
      <section className="error-boundary-card">
        <BrandLogo tagline={localizedBrand.tagline} />
        <p className="muted">Loading OfficeChat...</p>
      </section>
    </main>
  );
}
