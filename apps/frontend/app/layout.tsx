import type { Metadata, Viewport } from "next";
import "./globals.css";

import { getLocalizedBrand, officeChatBrand } from "../lib/brand";

const localizedBrand = getLocalizedBrand("en");

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_FRONTEND_URL ?? "http://localhost:3100"),
  title: {
    default: localizedBrand.title,
    template: `%s | ${officeChatBrand.productName}`
  },
  description: localizedBrand.description,
  applicationName: officeChatBrand.productName,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.svg", type: "image/svg+xml" }
    ],
    apple: [{ url: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" }]
  },
  openGraph: {
    title: localizedBrand.title,
    description: localizedBrand.description,
    siteName: officeChatBrand.productName,
    images: [{ url: "/brand/officechat-logo-square.svg", width: 128, height: 128 }],
    type: "website"
  },
  robots: {
    index: false,
    follow: false
  }
};

export const viewport: Viewport = {
  themeColor: "#1f2d29"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
