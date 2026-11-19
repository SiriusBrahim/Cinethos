import { expect, test } from '@playwright/test';
import { PROFILE_A, mockApi, savedItem, seedProfiles } from './fixtures.ts';

const continueItem = savedItem({
  id: 9100,
  media_type: 'tv',
  title: 'E2E Devam Dizisi',
  status: 'watching',
});

test.describe('Çalışma alanları', () => {
  test('ana sayfa kişisel karşılama, devam edenler ve son aktiviteyi gösterir', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await seedProfiles(page, [
      { id: PROFILE_A, name: 'E2E Kullanıcı', items: [continueItem] },
    ]);
    await mockApi(page);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: /E2E Kullanıcı/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Devam eden diziler' })).toBeVisible();
    await expect(page.getByText('E2E Devam Dizisi').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Son aktiviteler' })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('işlem merkezi gerçek görev kuyruğunu ve modül sağlığını listeler', async ({ page }) => {
    await seedProfiles(page, [{ id: PROFILE_A, name: 'E2E Kullanıcı' }]);
    await mockApi(page);

    await page.goto('/');
    await page.getByRole('tab', { name: 'İşlemler' }).click();

    await expect(page.getByRole('heading', { name: 'İşlem Merkezi' })).toBeVisible();
    await expect(page.getByText('Zevk profili telafisi')).toBeVisible();
    await expect(page.getByText('Kütüphane kaydı')).toBeVisible();
    await expect(page.getByText('geçici ağ hatası')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Modül sağlığı' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'İçerik işleme kuyruğu' })).toBeVisible();

    // Hata detayı sızdırılmamalı: sunucudaki dosya yolları arayüze taşınmaz.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('/tmp/never-exposed');
  });

  test('mobil "Daha fazla" sayfası dock dışındaki modüllere erişim verir', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await seedProfiles(page, [{ id: PROFILE_A, name: 'E2E Kullanıcı' }]);
    await mockApi(page);
    await page.goto('/');

    await expect(page.locator('.mobile-tab-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Daha fazla bölüm' }).click();

    const sheet = page.getByRole('dialog', { name: 'Tüm bölümler' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Seriler ve Evrenler' })).toBeVisible();

    await sheet.getByRole('button', { name: 'Seriler ve Evrenler' }).click();
    await expect(page.getByRole('heading', { name: 'Koleksiyonların ve eksik parçalar' })).toBeVisible();
    await expect(sheet).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, 'mobil çalışma alanı yatay taşmamalı').toBeLessThanOrEqual(1);

    await context.close();
  });
});
