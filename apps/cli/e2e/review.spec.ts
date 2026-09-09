import { commitInRepo, expect, reviewUrl, test } from "./fixtures";

test.describe("CLI review overlay", () => {
  test("boots a file-by-file review", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });

    const units = page.getByTestId("review-units");
    await expect(units.getByTestId("review-unit-0")).toBeVisible();
    await expect(units.getByTestId("review-unit-1")).toBeVisible();
    await expect(page.getByTestId("review-scope-select")).toBeVisible();
    await expect(page.getByTestId("structure-review")).toBeVisible();
    await expect(page.getByTestId("guided-review-overlay")).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("review-scope-select-option-branch")).toHaveCount(0);
  });

  test("Structure with AI without a key opens settings", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("structure-review")).toBeVisible();

    await page.getByTestId("structure-review").click();

    await expect(page).toHaveURL(/#settings/);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("settings-provider")).toBeVisible();
  });

  test("switching scope reloads the overlay diff", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });

    const units = page.getByTestId("review-units");
    await expect(units.getByTestId("review-unit-1")).toBeVisible();

    await page.getByTestId("review-scope-select").click();
    await page.getByTestId("review-scope-select-option-uncommitted").click();

    await expect(units.getByTestId("review-unit-1")).toBeVisible();
    await expect(units.getByTestId("review-unit-2")).toHaveCount(0);
  });

  test("a review survives being restarted", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });
    await page.getByTestId("review-units").getByTestId("review-unit-1").click();

    await page.getByTestId("comment-file-button").first().click();
    await page.getByTestId("comment-composer-input").fill("this needs a test");
    // The review is written to the git dir, so wait for it to land before
    // throwing the page away — that write is what a restart reads back.
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/review-state") && res.request().method() === "PUT",
      ),
      page.getByTestId("comment-composer-save").click(),
    ]);
    await expect(page.getByTestId("draft-comment-body")).toHaveText("this needs a test");

    await page.reload({ waitUntil: "domcontentloaded" });

    await page.getByTestId("review-units").getByTestId("review-unit-1").click();
    await expect(page.getByTestId("draft-comment-body")).toHaveText("this needs a test");
  });

  test("stale banner appears and Refresh reloads", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("structure-review")).toBeVisible();
    await expect(page.getByTestId("stale-diff-banner")).toHaveCount(0);

    await commitInRepo(reviewServer.repoDir, "feat.ts", "export const n = 2;\n");

    await expect(page.getByTestId("stale-diff-banner")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("stale-diff-refresh").click();

    await expect(page.getByTestId("structure-review")).toBeVisible();
    await expect(page.getByTestId("stale-diff-banner")).toHaveCount(0);
  });
});
