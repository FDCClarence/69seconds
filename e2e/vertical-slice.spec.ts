import { expect, test, type BrowserContext, type Page } from '@playwright/test';

async function register(page: Page, index: number): Promise<void> {
  const suffix = `${Date.now()}_${index}`;
  await page.goto('/');
  await page.getByRole('tab', { name: 'Register' }).click();
  await page.getByLabel('Username').fill(`shopper_${suffix}`.slice(0, 24));
  await page.getByLabel('Email').fill(`shopper_${suffix}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
}

test('four isolated players complete auth, room start, reconnection, and the 69-second tally', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await register(page, index);
    }

    const host = pages[0]!;
    await host.getByRole('button', { name: 'Create room' }).click();
    const roomCode = (await host.locator('.code').textContent())?.trim();
    expect(roomCode).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);

    for (const page of pages.slice(1)) {
      await page.getByLabel('Room code').fill(roomCode!);
      await page.getByRole('button', { name: 'Join room' }).click();
      await expect(page.getByText(roomCode!, { exact: true })).toBeVisible();
    }
    await expect(host.locator('.players > li')).toHaveCount(4);

    // Reloading preserves the cookie and authoritative roster slot without duplication.
    await pages[2]!.reload();
    await expect(pages[2]!.getByText(roomCode!, { exact: true })).toBeVisible();
    await expect(host.locator('.players > li')).toHaveCount(4);

    for (const page of pages) await page.getByRole('button', { name: 'Ready' }).click();
    await expect(host.getByRole('button', { name: 'Start match' })).toBeEnabled();
    await host.getByRole('button', { name: 'Start match' }).click();

    for (const page of pages) {
      await expect(page.getByRole('application', { name: /grocery store/i })).toBeVisible();
      await expect(page.getByText('Server synchronized')).toBeVisible();
    }

    // The production duration is intentionally not shortened by the fixture.
    for (const page of pages) {
      await expect(page.getByRole('heading', { name: /Time.s up/i })).toBeVisible({ timeout: 75_000 });
      await expect(page.getByText('final server tally')).toBeVisible();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('critical authenticated layout fits the supported 320-pixel viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await register(page, 9);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.locator('.code')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});
