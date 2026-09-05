import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { installAppApiRoutes } from "./support/app-fixtures";

const authStatePath = ".playwright/auth/user.json";

setup("password login creates the first organisation and rejects an external next URL", async ({ page }) => {
  const capture = await installAppApiRoutes(page, { needsBootstrap: true });

  await page.goto("/login?next=https%3A%2F%2Fevil.example%2Fsteal-session");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("WorldClassPass123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/dash$/u);
  await expect(page.getByRole("heading", { name: "New Analysis", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /Albert Bike Store/u }).last()).toBeVisible();
  await expect.poll(() => capture.bootstrapPayloads.length).toBe(1);
  expect(capture.bootstrapPayloads[0]).toEqual({
    displayName: "Albert Bike Store",
    timezone: "Australia/Melbourne",
  });
  expect(new URL(page.url()).origin).toBe("https://127.0.0.1:3101");

  await mkdir(dirname(authStatePath), { recursive: true });
  await page.context().storageState({ path: authStatePath });
});
