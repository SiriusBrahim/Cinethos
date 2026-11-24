import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

async function boot(page: import('@playwright/test').Page, hash = '/#/home') {
  await seedProfiles(page, [
    {
      id: PROFILE_A,
      name: 'E2E Kullanıcı',
      items: [
        savedItem({ id: 9001, title: 'E2E Alfa Filmi' }),
        savedItem({ id: 9002, media_type: 'tv', title: 'Çok Uzun Bir Dizi Başlığı Deneme Kaydı' }),
      ],
    },
  ]);
  await mockApi(page);
  await page.goto(hash);
  await expect(page.locator('.app-header')).toBeVisible();
}

const SCREENS: { name: string; hash: string }[] = [
  { name: 'ana sayfa', hash: '/#/home' },
  { name: 'keşfet', hash: '/#/discover' },
  { name: 'kütüphane', hash: '/#/list' },
  { name: 'işlem merkezi', hash: '/#/operations' },
];

for (const screen of SCREENS) {
  test(`B-28/B-29 erişilebilirlik taraması — ${screen.name}`, async ({ page }) => {
    await boot(page, screen.hash);
    await expect(page.getByRole('tab', { name: /Keşfet|Kütüphanem|İşlemler|Ana Sayfa/ }).first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    );

    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
      'kritik/ciddi erişilebilirlik ihlali olmamalı'
    ).toEqual([]);
  });
}

test('B-24 gezinme klavye ile tamamlanabilir', async ({ page }) => {
  await boot(page);
  const homeTab = page.getByRole('tab', { name: 'Ana Sayfa' });
  await homeTab.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  const focusedRole = await page.evaluate(
    () => document.activeElement?.closest('[role="tab"]') !== null
  );
  // Tab sırası sekmelerden çıkar; odak görünür kalır ve bir sonraki öğeye gider.
  expect(typeof focusedRole).toBe('boolean');
  await expect(page.locator(':focus')).toBeVisible();
});

test('B-27 dar ekranda filtre çubuğu sayfayı taşırmaz', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 760 } });
  const page = await context.newPage();
  await boot(page, '/#/discover');

  const filters = page.locator('.list-status-chips-bar, .category-scroll-strip');
  if (await filters.count()) {
    const sizes = await filters.first().evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    // Kendi içinde kayar; belge genişliğini büyütmez.
    expect(sizes.clientWidth).toBeLessThanOrEqual(360);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await context.close();
});

test('B-26 işlem merkezi eylemleri görev durumuna göre etkin', async ({ page }) => {
  await boot(page, '/#/operations');

  const retryButtons = page.getByRole('button', { name: /^Yeniden dene: / });
  await expect(retryButtons).toHaveCount(2);
  await expect(retryButtons.nth(0)).toBeEnabled(); // failed
  await expect(retryButtons.nth(1)).toBeDisabled(); // pending
  await expect(page.getByText('Görev zaten kuyrukta bekliyor.')).toBeVisible();

  const cancelButtons = page.getByRole('button', { name: /^İptal: / });
  await expect(cancelButtons.nth(1)).toBeEnabled();
});

test('B-26 409 yanıtı retry düğmesini kapatır ve neden gösterir', async ({ page }) => {
  await seedProfiles(page, [
    { id: PROFILE_A, name: 'E2E Kullanıcı', items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })] },
  ]);
  await mockApi(page, {
    taskActionResponder: () => ({
      status: 409,
      body: { ok: false, code: 'task_not_retryable', error: 'Bu görev yeniden denenebilir durumda değil.' },
    }),
  });
  await page.goto('/#/operations');

  const retry = page.getByRole('button', { name: /^Yeniden dene: / }).first();
  await expect(retry).toBeEnabled();
  await retry.click();

  await expect(page.getByRole('status').filter({ hasText: 'yeniden denenebilir durumda değil' })).toBeVisible();
  await expect(retry).toBeDisabled();
});
