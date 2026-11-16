import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileContext } from '../src/app/profile-context.ts';
import { ProfileConflictError } from '../src/contracts/index.ts';

/** K1 — profileId zorunluluğu: snapshot yoksa nötr referans döner. */
test('profile-context: profil yoksa nötr referans döner', () => {
  const ctx = createProfileContext({ getSnapshot: () => null });
  const current = ctx.getCurrent();
  assert.equal(current.profileId, '');
  assert.equal(current.revision, 0);
});

/** K1 — snapshot varsa profileId + revision döner. */
test('profile-context: güncel profil ve revision döner', async () => {
  const ctx = createProfileContext({
    getSnapshot: () => ({ activeProfileId: 'p1', revision: 7 }),
  });
  assert.deepEqual(ctx.getCurrent(), { profileId: 'p1', revision: 7 });
  assert.equal(await ctx.getRevision(), 7);
});

/** K3/K4 — profil değiştiyse assertCurrent reddeder. */
test('profile-context: profil değişimi profile-switched reddi üretir', () => {
  let snapshot = { activeProfileId: 'p1', revision: 3 };
  const ctx = createProfileContext({ getSnapshot: () => snapshot });
  const ref = ctx.getCurrent();

  // Kullanıcı B profiline geçer:
  snapshot = { activeProfileId: 'p2', revision: 4 };

  assert.throws(
    () => ctx.assertCurrent(ref),
    (err) => err instanceof ProfileConflictError && err.reason === 'profile-switched'
  );
});

/** K5 — eski revision'lı denetim stale-revision reddi üretir. */
test('profile-context: eski revision stale-revision reddi üretir', () => {
  const ctx = createProfileContext({
    getSnapshot: () => ({ activeProfileId: 'p1', revision: 9 }),
  });
  assert.throws(
    () => ctx.assertCurrent({ profileId: 'p1', revision: 8 }),
    (err) => err instanceof ProfileConflictError && err.reason === 'stale-revision'
  );
  // Güncel revision ile denetim geçer:
  ctx.assertCurrent({ profileId: 'p1', revision: 9 });
  // revision belirtilmemişse yalnızca profil kimliği denetlenir:
  ctx.assertCurrent({ profileId: 'p1' });
});

/** K4 — profil bulunamadığında profile-not-found reddi. */
test('profile-context: boş snapshot profile-not-found reddi üretir', () => {
  let snapshot = { activeProfileId: 'p1', revision: 1 };
  const ctx = createProfileContext({ getSnapshot: () => snapshot });
  const ref = ctx.getCurrent();
  snapshot = { activeProfileId: '', revision: 0 };
  assert.throws(
    () => ctx.assertCurrent(ref),
    (err) => err instanceof ProfileConflictError && err.reason === 'profile-not-found'
  );
});

/** K6 — profil değişimi dinleyicilere bildirilir (notifyIfChanged). */
test('profile-context: notifyIfChanged dinleyicileri tetikler', () => {
  let snapshot = { activeProfileId: 'p1', revision: 1 };
  const ctx = createProfileContext({ getSnapshot: () => snapshot });
  ctx.getCurrent();

  const events = [];
  ctx.onProfileChange((event) => events.push(event));

  snapshot = { activeProfileId: 'p2', revision: 2 };
  ctx.notifyIfChanged();

  assert.equal(events.length, 1);
  assert.equal(events[0].previous.profileId, 'p1');
  assert.equal(events[0].current.profileId, 'p2');
});

/** Dinleyici aboneliği kaldırılabilir. */
test('profile-context: unsubscribe dinleyiciyi kaldırır', () => {
  let snapshot = { activeProfileId: 'p1', revision: 1 };
  const ctx = createProfileContext({ getSnapshot: () => snapshot });
  ctx.getCurrent();

  const events = [];
  const sub = ctx.onProfileChange((event) => events.push(event));
  sub.unsubscribe();

  snapshot = { activeProfileId: 'p2', revision: 2 };
  ctx.notifyIfChanged();

  assert.equal(events.length, 0);
});

/** Hata fırlatan dinleyici bildirim zincirini bozmaz. */
test('profile-context: dinleyici hatası bildirimi bozmaz', () => {
  let snapshot = { activeProfileId: 'p1', revision: 1 };
  const ctx = createProfileContext({ getSnapshot: () => snapshot });
  ctx.getCurrent();

  const events = [];
  ctx.onProfileChange(() => {
    throw new Error('dinleyici hatası');
  });
  ctx.onProfileChange((event) => events.push(event));

  snapshot = { activeProfileId: 'p2', revision: 2 };
  ctx.notifyIfChanged();

  assert.equal(events.length, 1);
});
