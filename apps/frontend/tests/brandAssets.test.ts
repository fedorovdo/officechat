import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { metadata } from "../app/layout";
import { officeChatBrand } from "../lib/brand";

const frontendRoot = process.cwd();

describe("brand assets and metadata", () => {
  it("favicon and manifest assets exist", () => {
    expect(existsSync(join(frontendRoot, "public", "favicon.ico"))).toBe(true);
    expect(existsSync(join(frontendRoot, "public", "icon.svg"))).toBe(true);
    expect(existsSync(join(frontendRoot, "public", "icon-192.svg"))).toBe(true);
    expect(existsSync(join(frontendRoot, "public", "icon-512.svg"))).toBe(true);
    expect(existsSync(join(frontendRoot, "public", "manifest.webmanifest"))).toBe(true);
  });

  it("manifest contains installable metadata without claiming offline support", () => {
    const manifest = JSON.parse(readFileSync(join(frontendRoot, "public", "manifest.webmanifest"), "utf8"));
    expect(manifest.name).toBe(officeChatBrand.productName);
    expect(manifest.short_name).toBe(officeChatBrand.shortName);
    expect(manifest.display).toBe("standalone");
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain("serviceworker");
  });

  it("metadata config includes noindex, manifest and icons", () => {
    expect(metadata.applicationName).toBe(officeChatBrand.productName);
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.icons).toBeTruthy();
  });

  it("settings source includes About while keeping logout separate", () => {
    const source = readFileSync(join(frontendRoot, "components", "UserAppShell.tsx"), "utf8");
    expect(source).toContain("dictionary.appShell.about");
    expect(source).toContain("dictionary.dashboard.logout");
    expect(source).toContain("settings-menu-logout");
  });
});
