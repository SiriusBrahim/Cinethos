import test from 'node:test';
import assert from 'node:assert/strict';

function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
    _store: store,
  };
}

const localStorageStub = createLocalStorage();
globalThis.localStorage = localStorageStub;

const {
  ACTIVE_PROFILE_STORAGE,
  PROFILES_STORAGE,
  PROFILE_STORAGE,
  deletedKeysStorageKey,
  favActorsStorageKey,
  hasPersistedProfilesInStorage,
  listStorageKey,
  loadActiveProfileId,
  loadInitialProfiles,
  loadProfileItems,
  preferencesStorageKey,
} = await import('../src/app/profile-storage.ts');

test.beforeEach(() => localStorageStub.clear());

test('eski ham profil kimliğiyle yazılmış listeler kanonik kimliğe kayıpsız taşınır', () => {
  localStorageStub.setItem(
    PROFILES_STORAGE,
    JSON.stringify([{ id: 'profile-legacy', name: 'Eski Profil', createdAt: '2025-01-01' }])
  );
  localStorageStub.setItem(
    listStorageKey('profile-legacy'),
    JSON.stringify([
      { id: 101, media_type: 'movie', title: 'Eski Film', status: 'completed', personal_rating: 9 },
      { id: 202, media_type: 'tv', name: 'Eski Dizi', status: 'watching' },
      { id: 'bozuk', media_type: 'unknown' },
    ])
  );
  localStorageStub.setItem(
    preferencesStorageKey('profile-legacy'),
    JSON.stringify({ disliked: ['tv:5'], providers: ['netflix'], mood: 'dark' })
  );
  localStorageStub.setItem(
    favActorsStorageKey('profile-legacy'),
    JSON.stringify([{ id: 11, name: 'Elif Yılmaz' }])
  );
  const recentDeletion = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  localStorageStub.setItem(
    deletedKeysStorageKey('profile-legacy'),
    JSON.stringify({ 'movie:7': recentDeletion })
  );

  assert.equal(hasPersistedProfilesInStorage(), true);
  const profiles = loadInitialProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'PROFILE-LEGACY');
  assert.equal(profiles[0].items.length, 2, 'geçersiz kayıt elenir, geçerli ikisi korunur');
  assert.equal(profiles[0].preferences.mood, 'dark');
  assert.deepEqual(profiles[0].favoriteActors.map((actor) => actor.id), [11]);
  assert.equal(profiles[0].deleted_keys['movie:7'], recentDeletion);
});

test('aynı kanonik kimliğe düşen iki kayıt birleştirilir, liste kaybı olmaz', () => {
  localStorageStub.setItem(
    PROFILES_STORAGE,
    JSON.stringify([
      { id: 'profile-abc', name: 'A', createdAt: '' },
      { id: 'PROFILE-ABC', name: 'A2', createdAt: '' },
    ])
  );
  localStorageStub.setItem(
    listStorageKey('profile-abc'),
    JSON.stringify([{ id: 1, media_type: 'movie', title: 'Bir', status: 'watchlist' }])
  );
  localStorageStub.setItem(
    listStorageKey('PROFILE-ABC'),
    JSON.stringify([{ id: 1, media_type: 'movie', title: 'Bir', status: 'watchlist' }])
  );

  const profiles = loadInitialProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].items.length, 1, 'çift kayıt birleştirilir');
});

test('profil yoksa varsayılan profil üretilir ve aktif profil güvenli seçilir', () => {
  const profiles = loadInitialProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'PROFILE-DEFAULT');
  assert.equal(loadActiveProfileId(profiles), 'PROFILE-DEFAULT');

  localStorageStub.setItem(ACTIVE_PROFILE_STORAGE, 'profile-abc');
  assert.equal(loadActiveProfileId(profiles), 'PROFILE-DEFAULT', 'bilinmeyen aktif kimlik yok sayılır');
});

test('legacy tek profil adı korunur; profil listesi boşsa kullanılır', () => {
  localStorageStub.setItem(PROFILE_STORAGE, 'Eski Kullanıcı');
  const profiles = loadInitialProfiles();
  assert.equal(profiles[0].name, 'Eski Kullanıcı');
});

test('profil listeleri profil kimliğine göre izole okunur', () => {
  localStorageStub.setItem(
    listStorageKey('PROFILE-A'),
    JSON.stringify([{ id: 1, media_type: 'movie', title: 'A Filmi' }])
  );
  localStorageStub.setItem(
    listStorageKey('PROFILE-B'),
    JSON.stringify([{ id: 2, media_type: 'tv', name: 'B Dizisi' }])
  );
  assert.equal(loadProfileItems('PROFILE-A')[0].id, 1);
  assert.equal(loadProfileItems('PROFILE-B')[0].id, 2);
});
