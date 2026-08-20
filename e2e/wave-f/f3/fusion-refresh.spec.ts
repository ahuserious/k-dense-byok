import { expect, test } from "../../live-fixtures";

test.describe("Settings ▸ Fusion model refresh", () => {
  test("the live Fusion editor shows GPT-5.6 Sol Pro and no GPT-5.5 model", async ({
    liveWorkspace,
  }) => {
    const { page } = liveWorkspace;
    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "Fusion" }).click();
    await expect(
      settings.getByRole("heading", { name: "Fusion Configurations" }),
    ).toBeVisible();

    const refreshedName = settings.getByText(
      "Fable 5 + GPT-5.6 Sol Pro",
      { exact: true },
    );
    await expect(refreshedName).toBeVisible();
    await expect(
      settings.getByText(/Panel: .*openai\/gpt-5\.6-sol-pro/).first(),
    ).toBeVisible();
    await expect(settings.getByText(/GPT-5\.5/i)).toHaveCount(0);

    await refreshedName.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("f3-fusion-gpt56-sol-pro.png"),
    });
  });

  test("the chat model picker exposes the refreshed Fusion preset", async ({
    liveWorkspace,
  }) => {
    const { page } = liveWorkspace;
    await page.getByRole("button", { name: /^Select model/ }).click();
    const picker = page.getByRole("listbox");
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole("option", {
        name: "Fable 5 + GPT-5.6 Sol Pro by Openrouter Fusion",
      }),
    ).toBeVisible();
    await expect(picker.getByText(/GPT-5\.5/i)).toHaveCount(0);
  });
});
