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
  test(`layout ${viewport.name}`, async ({ browser }, testInfo) => {
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

    // Guncel kabuk: Header her genislikte gorunur; header-nav-tabs yalnizca >768px,
    // <=768px'te ise sabit alt gezinme .mobile-tab-bar devrededir
    // (components.css @media max-width:768px .header-nav-tabs { display:none }).
    // Eski MobileTopBar/MobileDock/AppSidebar kabugu kaldirildi; AppSidebar su anda render edilmiyor.
    await expect(page.locator('.app-header')).toBeVisible();
    if (viewport.width <= 768) {
      await expect(page.locator('.header-nav-tabs')).toBeHidden();
      await expect(page.locator('.mobile-tab-bar')).toBeVisible();
    } else {
      await expect(page.locator('.header-nav-tabs')).toBeVisible();
    }
    await expect(page.locator('main.shell')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, 'sayfa yatay olarak taşmamalı').toBeLessThanOrEqual(1);

    // Gorunur gezinme ogesi uzerinden Kutuphane'ye gec: mobil dock etiketi
    // 'Kütüphane', masaustu sekmesi ise 'Kütüphanem'.
    if (viewport.width <= 768) {
      await page.locator('.mobile-tab-btn', { hasText: 'Kütüphane' }).click();
    } else {
      await page.locator('[role="tab"]:visible', { hasText: 'Kütüphanem' }).first().click();
    }
    await expect(page.getByText('E2E Alfa Filmi').first()).toBeVisible();

    await testInfo.attach('responsive-' + viewport.name, {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    const wrappedCard = page.locator('.wrapped-summary-card');
    await expect(wrappedCard).toBeVisible();
    await wrappedCard.scrollIntoViewIfNeeded();
    await testInfo.attach('wrapped-card-' + viewport.name, {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    await context.close();
  });
}
