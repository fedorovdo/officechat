import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OfficeChat",
  description: "Local corporate chat for self-hosted environments"
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
