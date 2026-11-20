import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserDataDocument } from '../src/app/user-data-payload.ts';

function profile(id, overrides = {}) {
  return {
    id,
    name: id,
    createdAt: '',
    preferences: { disliked: [`movie:9${id.length}`], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
    items: [{ id: 1, media_type: 'movie', title: 'Profil ' + id, status: 'watchlist', personal_rating: '' }],
    favoriteActors: [{ id: 1, name: 'Oyuncu ' + id }],
    deleted_keys: { 'movie:77': '2026-11-01T00:00:00.000Z' },
    ...overrides,
  };
}

test('aktif profil canlı veriden, diğer profiller kendi verisinden yazılır', () => {
  const doc = buildUserDataDocument({
    profiles: [profile('p2-aaa'), profile('p2-bbb')],
    activeProfileId: 'p2-aaa',
    profileName: 'Aktif',
    preferences: { disliked: ['tv:5'], hidden: [], providers: [], mood: 'dark', reminders: false, notified: [] },
    savedItems: [{ id: 42, media_type: 'tv', title: 'Canlı', status: 'watching', personal_rating: 8 }],
    favoriteActors: [{ id: 7, name: 'Canlı Oyuncu' }],
    deletedKeys: { 'movie:88': '2026-11-02T00:00:00.000Z' },
  });

  assert.equal(doc.version, 3);
  assert.equal(doc.activeProfileId, 'p2-aaa');
  const active = doc.profiles.find((p) => p.id === 'p2-aaa');
  const other = doc.profiles.find((p) => p.id === 'p2-bbb');
  assert.equal(active.name, 'Aktif');
  assert.equal(active.items[0].title, 'Canlı');
  assert.deepEqual(active.preferences.disliked, ['tv:5']);
  assert.ok(active.deleted_keys['movie:88']);
  assert.equal(other.name, 'p2-bbb');
  assert.equal(other.items[0].title, 'Profil p2-bbb');
  assert.deepEqual(other.preferences.disliked, ['movie:96']);
  assert.ok(other.deleted_keys['movie:77']);
});

test('profil verileri birbirine taşınmaz', () => {
  const doc = buildUserDataDocument({
    profiles: [profile('p2-ccc'), profile('p2-ddd')],
    activeProfileId: 'p2-ddd',
    profileName: 'D',
    preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
    savedItems: [],
    favoriteActors: [],
    deletedKeys: {},
  });
  const c = doc.profiles.find((p) => p.id === 'p2-ccc');
  const d = doc.profiles.find((p) => p.id === 'p2-ddd');
  assert.equal(d.items.length, 0);
  assert.equal(c.items[0].title, 'Profil p2-ccc');
  assert.equal(c.deleted_keys['movie:77'] !== undefined, true);
  assert.equal(d.deleted_keys, undefined);
});
