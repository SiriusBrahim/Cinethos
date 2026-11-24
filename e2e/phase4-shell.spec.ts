import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

async function boot(page: import('@playwright/test').Page) {
  await seedProfiles(page, [
    {
      id: PROFILE_A,
      name: 'E2E Kullanıcı',
      items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })],
    },
  ]);
  await mockApi(page);
  await page.goto('/#/discover');
  await expect(page.locator('.app-header')).toBeVisible();
}

for (const width of [1024, 1280, 1440]) {
  test(`B-24 masaüstü gezinme ${width}px taşmaz`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await boot(page);

    const nav = page.locator('.header-nav-tabs');
    await expect(nav).toBeVisible();

    // Sekmelerin tamamı yatay olarak kaydırma gerektirmeden sığmalı.
    const metrics = await nav.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(metrics.scrollWidth - metrics.clientWidth, 'sekme şeridi taşmamalı').toBeLessThanOrEqual(1);

    const headerBox = await page.locator('.app-header').boundingBox();
    expect(headerBox?.height ?? 0).toBeLessThanOrEqual(80);

    const tabs = page.locator('.header-nav-tabs [role="tab"]');
    await expect(tabs).toHaveCount(7);
    for (let index = 0; index < 7; index += 1) {
      const box = await tabs.nth(index).boundingBox();
      expect(box, `sekme ${index} görünür olmalı`).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      // Görsel etiket gizlense bile erişilebilir ad korunur.
      expect((await tabs.nth(index).getAttribute('aria-label'))?.length ?? 0).toBeGreaterThan(0);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await context.close();
  });
}

test('B-24 aktif sekme aria-current ile duyurulur', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: /Kütüphanem/ }).click();
  await expect(page.getByRole('tab', { name: /Kütüphanem/ })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByRole('tab', { name: 'Keşfet' })).not.toHaveAttribute('aria-current');
});

test('B-24 mobil dock dokunma hedefleri ve taşma menüsü', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 720 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await boot(page);

  const buttons = page.locator('.mobile-tab-btn');
  await expect(buttons).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, `dock düğmesi ${index} yüksekliği`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `dock düğmesi ${index} genişliği`).toBeGreaterThanOrEqual(44);
  }

  // Alt gezinme içeriği örtmemeli: body alt boşluğu dock yüksekliği kadar.
  const bodyPadding = await page.evaluate(
    () => Number.parseFloat(getComputedStyle(document.body).paddingBottom)
  );
  expect(bodyPadding).toBeGreaterThanOrEqual(48);

  await page.getByRole('button', { name: 'Daha fazla bölüm' }).click();
  const sheet = page.getByRole('dialog', { name: 'Tüm bölümler' });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('button', { name: 'İşlem Merkezi' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Daha fazla bölüm' })).toBeFocused();

  await context.close();
});

test('B-25 klavye: atlama bağlantısı içeriğe götürür', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Tab');
  const skip = page.locator('.skip-link');
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator('#main-content')).toBeFocused();
});

test('B-29 kısayollar metin girişinde ve modal açıkken çalışmaz', async ({ page }) => {
  await boot(page);

  await page.locator('.search-input').click();
  await page.keyboard.type('3');
  await expect(page.getByRole('tab', { name: 'Keşfet' })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Profil:/ }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('2');
  // Kabuk `inert` olduğu için sekmeler erişilebilirlik ağacında görünmez;
  // bu yüzden aktif sekme DOM üzerinden doğrulanır.
  await expect(page.locator('[role="tab"][aria-label="Keşfet"]')).toHaveAttribute(
    'aria-current',
    'page'
  );
});

test('B-28 modal odak tuzağı, Escape ve odak dönüşü', async ({ page }) => {
  await boot(page);

  const opener = page.getByRole('button', { name: /^Profil:/ });
  await opener.focus();
  await opener.press('Enter');

  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();

  // Arka plan kabuğu erişim dışı.
  await expect(page.locator('main.shell')).toHaveAttribute('inert', '');

  // Odak dialog içinde kalır.
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return Boolean(active?.closest('[role="dialog"]'));
    });
    expect(inside, 'odak dialog dışına kaçmamalı').toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('main.shell')).not.toHaveAttribute('inert');
  await expect(opener).toBeFocused();
});
