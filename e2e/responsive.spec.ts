import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

const VIEWPORTS = [
  { name: 'mobil-360x640', width: 360, height: 640 },
  { name: 'mobil-390x844', width: 390, height: 844 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'laptop-1024x768', width: 1024, height: 768 },
  { name: 'masaustu-1440x900', width: 1440, height: 900 },
  { name: 'genis-1920x1080', width: 1920, height: 1080 },
];

for (const viewport of VIEWPORTS) {
  test(`layout ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    await seedProfiles(page, [
      {
        id: PROFILE_A,
        name: 'E2E Kullanıcı',
        items: [savedItem({ id: 9001, title: 'E2E Alfa Filmi' })],
      },
    ]);
    await mockApi(page);

    await page.goto('/');

    // ef031af kabugu: <=768px mobil kabuk devrede (header gizli; MobileTopBar + MobileDock),
    // 769-1023px arasi header nav listesi, >=1024px'te ise sidebar nav listesi gorunurdur
    // (header-nav-tabs CSS ile gizlenir -- app.css @media min-width:1024px).
    if (viewport.width <= 768) {
      await expect(page.locator('.mobile-topbar')).toBeVisible();
      await expect(page.locator('.mobile-dock')).toBeVisible();
      await expect(page.locator('.app-header')).toBeHidden();
    } else if (viewport.width < 1024) {
      await expect(page.locator('.app-header')).toBeVisible();
      await expect(page.locator('.header-nav-tabs')).toBeVisible();
    } else {
      await expect(page.locator('.app-header')).toBeVisible();
      await expect(page.locator('.sidebar-nav-list')).toBeVisible();
    }
    await expect(page.locator('main.shell')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, 'sayfa yatay olarak taşmamalı').toBeLessThanOrEqual(1);

    // Gorunur gezinme ogesi uzerinden Listem'e gec (mobil dockta etiket 'Kutuphane').
    if (viewport.width <= 768) {
      await page.locator('.mobile-dock-btn', { hasText: 'Kütüphane' }).click();
    } else {
      await page.locator('[role="tab"]:visible', { hasText: 'Listem' }).first().click();
    }
    await expect(page.getByText('E2E Alfa Filmi').first()).toBeVisible();

    await context.close();
  });
}
