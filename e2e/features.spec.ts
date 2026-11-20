import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";

test.setTimeout(45000);
const api = "http://127.0.0.1:5017/api";
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Your message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0, { timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Regenerate response" }),
  ).toBeVisible();
}
async function stored(page: Page, request: APIRequestContext) {
  const id = await page.evaluate(() =>
    localStorage.getItem("activeConversation"),
  );
  const response = await request.get(`${api}/conversations/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).conversation;
}

test("regeneration streams a preview while retaining original, then replaces the stored answer", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await send(page, "Regenerate check alpha");
  const before = await stored(page, request);
  await page.getByLabel("Response tone").selectOption("concise");
  await page.getByRole("button", { name: "Regenerate response" }).click();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toBeVisible();
  await expect(page.locator(".messages")).toContainText(
    "professional response.",
  );
  await expect(
    page.getByRole("textbox", { name: "Your message" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".messages")).toContainText("concise response.");
  await expect(page.locator(".messages")).toContainText("Revision 2.");
  const after = await stored(page, request);
  expect(after.messages.map((message: { _id: string }) => message._id)).toEqual(
    before.messages.map((message: { _id: string }) => message._id),
  );
  expect(after.messages).toHaveLength(2);
  expect(after.messages[1].tone).toBe("concise");
  await page.reload();
  await expect(page.locator(".messages")).toContainText("Revision 2.");
  await expect(page.locator(".messages")).not.toContainText("Revision 1.");
});

for (const outcome of ["failure", "cancel"] as const) {
  test(`regeneration ${outcome} keeps the original answer and message ordering`, async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await send(page, `Regenerate ${outcome} check`);
    const before = await stored(page, request);
    await page.getByRole("button", { name: "Regenerate response" }).click();
    if (outcome === "cancel") {
      await expect(
        page.getByRole("button", { name: "Stop generating" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Stop generating" }).click();
    }
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop generating" }),
    ).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(".messages")).toContainText("Revision 1.");
    const after = await stored(page, request);
    expect(after.messages).toEqual(before.messages);
    await page.reload();
    await expect(page.locator(".messages")).toContainText("Revision 1.");
  });
}

test("search finds persisted message text after reload, navigates and highlights, and clears", async ({
  page,
}) => {
  await page.goto("/");
  await send(page, "A searchable archived thread");
  await send(page, "Message contains NebulaNeedle for search navigation.");
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.reload();
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.fill("NEBULANEEDLE");
  const result = page
    .getByRole("button")
    .filter({ hasText: "A searchable archived thread" });
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("NebulaNeedle");
  await result.click();
  await expect(page.locator(".messages")).toContainText("NebulaNeedle");
  await expect(page.locator(".message-highlight")).toContainText(
    "NebulaNeedle",
  );
  await search.fill("no-match-unique-zzzyyy");
  await expect(
    page.getByText("No matching conversations", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(
    page.getByText("No matching conversations", { exact: true }),
  ).toHaveCount(0, { timeout: 15000 });
  await search.fill("searchable archived");
  await expect(
    page
      .getByRole("button")
      .filter({ hasText: "A searchable archived thread" }),
  ).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await search.fill("NEBULANEEDLE");
  await result.click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await expect(page.locator(".message-highlight")).toBeInViewport();
  await page.screenshot({
    path: "artifacts/search-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.route("**/api/conversations/search?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { message: "Search temporarily unavailable" },
      }),
    }),
  );
  await search.fill("query server failure");
  await expect(
    page.getByText("Search temporarily unavailable", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/conversations/search?*");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByText("Search temporarily unavailable", { exact: true }),
  ).toHaveCount(0);
});
