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

  test("command-clicking a symbol previews its declaration and opens it in a tab", async ({
    page,
    context,
    reviewServer,
  }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });
    await page.getByTestId("review-units").getByTestId("review-unit-1").click();

    // Click the identifier itself, not the middle of the line: the gesture is
    // resolved from the caret position, so the coordinates are the test.
    const point = await page.evaluate(() => {
      for (const cell of document.querySelectorAll("[data-code-text]")) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.indexOf("helperFn") ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + "helperFn".length);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0) continue;
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    });
    expect(point).not.toBeNull();

    // The underline is the affordance: it appears on the modifier alone, with
    // the pointer already parked on the symbol.
    await page.mouse.move(point!.x, point!.y);
    await expect(page.getByTestId("symbol-underline")).toHaveCount(0);
    await page.keyboard.down("ControlOrMeta");
    await expect(page.getByTestId("symbol-underline")).not.toHaveCount(0);

    await page.mouse.click(point!.x, point!.y);
    await page.keyboard.up("ControlOrMeta");

    const preview = page.getByTestId("definition-preview");
    const snippet = preview.getByTestId("definition-preview-snippet");
    await expect(snippet).toContainText("export function helperFn");

    // Reading past the declaration must not count as leaving the card.
    await snippet.hover();
    await page.mouse.wheel(0, 400);
    await expect(async () => {
      expect(await snippet.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    }).toPass();
    await expect(preview).toBeVisible();

    const [sourceTab] = await Promise.all([
      context.waitForEvent("page"),
      preview.getByTestId("definition-preview-open").click(),
    ]);
    await expect(sourceTab.getByTestId("source-path")).toHaveText("lib/helper.ts:1");
    await expect(sourceTab.getByTestId("source-target-line")).toContainText(
      "export function helperFn",
    );
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

  test("Start Over discards the saved review", async ({ page, reviewServer }) => {
    await page.goto(reviewUrl(reviewServer), { waitUntil: "domcontentloaded" });
    await page.getByTestId("review-units").getByTestId("review-unit-1").click();

    // Nothing to throw away yet, so the escape hatch stays out of the way.
    await page.getByTestId("review-units").getByTestId("review-unit-0").click();
    await expect(page.getByTestId("start-over")).toHaveCount(0);

    await page.getByTestId("review-units").getByTestId("review-unit-1").click();
    await page.getByTestId("comment-file-button").first().click();
    await page.getByTestId("comment-composer-input").fill("scrap this");
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/review-state") && res.request().method() === "PUT",
      ),
      page.getByTestId("comment-composer-save").click(),
    ]);

    await page.getByTestId("review-units").getByTestId("review-unit-0").click();
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/review-state") && res.request().method() === "DELETE",
      ),
      (async () => {
        await page.getByTestId("start-over").click();
        await page.getByTestId("confirmation-ok").click();
      })(),
    ]);

    // Gone from this page, and gone from disk — a reload does not bring it back.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("review-units").getByTestId("review-unit-1").click();
    await expect(page.getByTestId("draft-comment")).toHaveCount(0);
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
