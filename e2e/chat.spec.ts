import { test, expect } from "@playwright/test";
test("stream, multi-turn tone, persistence, retrieval and deletion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Good questions." }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Your message" });
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await input.fill("Explain hashing");
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await expect(page.locator(".messages")).toContainText(
    "professional response. Context contains 1 messages.",
  );
  await page.getByLabel("Response tone").selectOption("concise");
  await input.fill("And collisions?");
  await input.press("Enter");
  await expect(page.locator(".messages")).toContainText(
    "concise response. Context contains 3 messages.",
  );
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".messages")).toContainText("And collisions?");
  await expect(page.getByLabel("Response tone")).toHaveValue("concise");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator(".messages")).toHaveCount(0);
  await page
    .locator(".history-select")
    .filter({ hasText: "Explain hashing" })
    .click();
  await expect(page.locator(".messages")).toContainText("And collisions?");
  await page
    .getByRole("button", { name: "Delete Explain hashing", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.locator(".history-select").filter({ hasText: "Explain hashing" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("provider failure restores draft and cancellation has a terminal state", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Your message" });
  await input.fill("trigger-error");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("could not complete");
  await expect(input).toHaveValue("trigger-error");
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await input.fill("slow response");
  await input.press("Enter");
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("slow response");
  await expect(page.getByRole("alert")).toContainText("stopped");
});
test("mobile layout fits viewport and sidebar opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Your message" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "New conversation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("switching conversations cancels old stream without mixing; casual tone and multiline", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Your message" });
  await page.getByLabel("Response tone").selectOption("casual");
  await input.fill("A casual question");
  await input.press("Shift+Enter");
  await input.press("x");
  await expect(input).toHaveValue("A casual question\nx");
  await input.press("Enter");
  await expect(page.locator(".messages")).toContainText("casual response.");
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "New conversation" }).click();
  await input.fill("slow isolated request");
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toBeVisible();
  await page
    .locator(".history-select")
    .filter({ hasText: "A casual question" })
    .click();
  await expect(page.locator(".messages")).toContainText("casual response.");
  await expect(page.locator(".messages")).not.toContainText(
    "slow isolated request",
  );
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
});
