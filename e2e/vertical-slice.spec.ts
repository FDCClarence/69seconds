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

test('four isolated players complete auth, room start, reconnection, and the 69-second looting round', async ({ browser }) => {
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

    // A brief transport loss pauses intent, preserves the authoritative slot,
    // and resynchronizes the same in-progress match when the network returns.
    const reconnectingPage = pages[2]!;
    await contexts[2]!.setOffline(true);
    await expect(reconnectingPage.getByText('Connection lost — reconnecting')).toBeVisible();
    await contexts[2]!.setOffline(false);
    await expect(reconnectingPage.getByText('Server synchronized')).toBeVisible({ timeout: 15_000 });

    // The full gameplay HUD remains usable at the documented minimum width.
    const narrowPage = pages[3]!;
    await narrowPage.setViewportSize({ width: 320, height: 568 });
    await expect(narrowPage.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect(await narrowPage.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);

    // The production duration is intentionally not shortened by the fixture. At
    // the authoritative looting deadline every client leaves the store scene for
    // the server-owned survival day.
    for (const page of pages) {
      await expect(page.getByRole('heading', { name: 'Survival phase' })).toBeVisible({ timeout: 75_000 });
      await expect(page.getByRole('application', { name: /grocery store/i })).toBeHidden();
      // The day is playable: every client gets the server's own countdown, its
      // own household's resources, and the one decision the day offers.
      await expect(page.getByRole('timer')).toBeVisible();
      await expect(page.getByRole('meter', { name: /Nutrition$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'End day' })).toBeEnabled();
    }
    expect(await narrowPage.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);
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
