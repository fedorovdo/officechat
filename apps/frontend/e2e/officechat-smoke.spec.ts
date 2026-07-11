import { expect, test } from "@playwright/test";

const destructiveAllowed = process.env.E2E_ALLOW_DESTRUCTIVE_TESTS === "true";
const environment = process.env.ENVIRONMENT ?? "development";
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "admin12345";
const backendURL = process.env.E2E_BACKEND_URL ?? "http://backend:8000";

test.beforeAll(() => {
  if (environment === "production" && !destructiveAllowed) {
    throw new Error("Refusing to run OfficeChat E2E tests against production without E2E_ALLOW_DESTRUCTIVE_TESTS=true");
  }
});

test("frontend health route is available", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body).toEqual(expect.objectContaining({ status: "ok", service: "officechat-frontend" }));
});

test("localized login page renders and API rejects invalid credentials", async ({ page, request }) => {
  await page.goto("/ru/login");
  await expect(page.getByRole("heading", { name: /вход/i })).toBeVisible();
  const response = await request.post(`${backendURL}/api/auth/login`, {
    data: { username: "invalid-user", password: "invalid-password" }
  });
  expect(response.status()).toBe(401);
});

test("admin can log in and open the app shell", async ({ page }) => {
  test.skip(!destructiveAllowed, "Set E2E_ALLOW_DESTRUCTIVE_TESTS=true to run authenticated smoke flows.");

  await page.goto("/ru/login");
  await page.locator('input[autocomplete="username"]').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"]').fill(adminPassword);
  await page.getByRole("button", { name: /login|войти/i }).click();
  await page.getByRole("link", { name: /OfficeChat|Открыть OfficeChat/i }).click();
  await expect(page).toHaveURL(/\/ru\/app/);
  await expect(page.getByText(/Groups|Группы/)).toBeVisible();
});
