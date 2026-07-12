import Image from "next/image";

import { officeChatBrand } from "../lib/brand";

type BrandProps = {
  compact?: boolean;
  tagline?: string;
  variant?: "light" | "dark";
  className?: string;
};

export function BrandMark({
  className = "",
  compact = false
}: Pick<BrandProps, "className" | "compact">) {
  return (
    <span
      aria-label={officeChatBrand.productName}
      className={["brand-mark", compact ? "brand-mark-compact" : "", className].filter(Boolean).join(" ")}
      role="img"
    >
      <Image
        alt=""
        aria-hidden="true"
        height={compact ? 32 : 40}
        src="/brand/officechat-mark.svg"
        width={compact ? 32 : 40}
      />
      <span className="visually-hidden">{officeChatBrand.productName}</span>
    </span>
  );
}

export function ProductWordmark({ compact = false, tagline }: BrandProps) {
  if (compact) return null;
  return (
    <span className="brand-wordmark">
      <strong>{officeChatBrand.productName}</strong>
      {tagline ? <small>{tagline}</small> : null}
    </span>
  );
}

export function BrandLogo({ compact = false, tagline, variant = "light", className = "" }: BrandProps) {
  return (
    <span
      className={["brand-logo", `brand-logo-${variant}`, compact ? "brand-logo-compact" : "", className]
        .filter(Boolean)
        .join(" ")}
      title={officeChatBrand.productName}
    >
      <BrandMark compact={compact} />
      <ProductWordmark compact={compact} tagline={tagline} />
    </span>
  );
}

