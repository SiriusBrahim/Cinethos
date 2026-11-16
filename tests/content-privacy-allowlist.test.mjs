/**
 * MIA Faz 2 — Adım 2.1 (Dilim D): Ortak içerik deposu gizlilik allowlist sınırı.
 *
 * Kabul kriterleri (docs/mia/faz1-faz2-uygulama-plani.md 2.1):
 *  - Ortak içerik deposuna girebilecek alanlar açık allowlist ile tanımlanır;
 *    bilinmeyen alanlar varsayılan olarak atılır (default-deny).
 *  - Kişisel alanlar (profileId, rating, notes, status, izleme ilerlemesi vb.)
 *    üst seviyede VE iç içe nesne/diziler içinde de temizlenir.
 *  - Farklı yazım / büyük-küçük harf / nested biçimle sınır aşılamaz.
 *  - ContentMetadataProcessor ve ContentIntelligenceRepository aynı sınırı uygular.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COMMON_METADATA_ALLOWLIST,
  createContentMetadataProcessor,
  sanitizeRawContentInput,
} from '../src/modules/content/content-metadata-processor.ts';
import { createContentIntelligenceRepository } from '../src/server/content-intelligence-repository.ts';

function makeTempDir(prefix = 'cinethos-privacy-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const PERSONAL_TRAPS = {
  profileId: 'user-secret-profile',
  Profile_ID: 'user-secret-profile',
  USER_ID: 42,
  status: 'watched',
  List: 'watched',
  personal_rating: 9.5,
  PersonalRating: 9.5,
  notes: 'Özel kişisel notum',
  NOTE: 'Özel kişisel notum',
  user_note: 'Özel kişisel notum',
  yorum: 'Özel kişisel notum',
  episodes_watched: 7,
  season_progress: { season: 2, episode: 5 },
  hidden: true,
  notInterested: true,
  favoriteActors: [{ id: 819, name: 'Edward Norton' }],
};

test('Allowlist: bilinmeyen alanlar default-deny ile atılır, bilinen ortak metaveri korunur', () => {
  const result = sanitizeRawContentInput({
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    overview: 'Test özeti.',
    genres: [{ id: 18, name: 'Drama' }],
    release_date: '1999-10-15',
    runtime: 139,
    // Bilinmeyen alanlar (denylist'te yok ama allowlist'te de yok → atılmalı)
    unexpected_future_field: 'bilinmeyen',
    someNestedUnknown: { inner: 'değer' },
    ...PERSONAL_TRAPS,
  });

  assert.equal(result.sanitized.id, 550);
  assert.equal(result.sanitized.title, 'Fight Club');
  assert.equal(result.sanitized.overview, 'Test özeti.');
  assert.ok(Array.isArray(result.sanitized.genres));

  // Default-deny: allowlist dışındaki her şey atıldı.
  assert.equal(result.sanitized.unexpected_future_field, undefined);
  assert.equal(result.sanitized.someNestedUnknown, undefined);
  assert.ok(result.strippedUnknownFields.includes('unexpected_future_field'));
  assert.ok(result.strippedUnknownFields.includes('someNestedUnknown'));
});

test('Allowlist: kişisel alanlar farklı kasalarda ve nested nesnelerde de temizlenir', () => {
  const result = sanitizeRawContentInput({
    id: 1396,
    media_type: 'tv',
    name: 'Breaking Bad',
    credits: {
      crew: [
        {
          id: 7467,
          name: 'Vince Gilligan',
          job: 'Executive Producer',
          // nested kişisel sızıntı denemeleri
          profileId: 'user-secret-profile',
          personal_rating: 10,
          notes: 'Özel kişisel notum',
        },
      ],
      cast: [
        {
          id: 819,
          name: 'Bryan Cranston',
          character: 'Walter White',
          order: 0,
          // nested görsel + kişisel
          profile_path: '/cranston.jpg',
          status: 'watched',
          episodes_watched: 62,
        },
      ],
    },
    keywords: [
      { id: 1, name: 'chemistry' },
      { id: 2, name: 'methamphetamine', user_note: 'Özel kişisel notum' },
    ],
    ...PERSONAL_TRAPS,
  });

  const serialized = JSON.stringify(result.sanitized);
  for (const needle of [
    'user-secret-profile',
    'Özel kişisel notum',
    'personal_rating',
    'episodes_watched',
    'profile_path',
    'cranston.jpg',
  ]) {
    assert.equal(serialized.includes(needle), false, `Sızıntı: ${needle}`);
  }

  // Meşru kredi alanları korunur.
  const crew = result.sanitized.credits.crew[0];
  assert.equal(crew.name, 'Vince Gilligan');
  assert.equal(crew.job, 'Executive Producer');
  const castEntry = result.sanitized.credits.cast[0];
  assert.equal(castEntry.character, 'Walter White');

  // Kişisel alan strip raporları hem üst seviye hem nested alanları içerir.
  const strippedLower = result.strippedPersonalFields.map((f) => f.toLowerCase());
  assert.ok(strippedLower.includes('profileid'));
  assert.ok(strippedLower.includes('notes'));
  assert.ok(strippedLower.includes('profile_id') || strippedLower.includes('profileid'));
});

test('Allowlist: allowlist kümesi kişisel/görsel alanları İÇERMEZ (tasarım sınırı)', () => {
  for (const forbidden of [
    'profileid',
    'userid',
    'status',
    'list',
    'personalrating',
    'rating',
    'notes',
    'note',
    'usernote',
    'yorum',
    'episodeswatched',
    'seasonprogress',
    'hidden',
    'notinterested',
    'favoriteactors',
    'posterpath',
    'backdroppath',
    'profilepath',
    'stillpath',
    'logopath',
    'posterblob',
    'posterdataurl',
  ]) {
    assert.equal(
      COMMON_METADATA_ALLOWLIST.has(forbidden),
      false,
      `Allowlist kişisel/görsel alan içeremez: ${forbidden}`
    );
  }
});

test('Allowlist: processor doğrulama çıktısı sızıntı raporlar ve hash kişisel alandan etkilenmez', () => {
  const processor = createContentMetadataProcessor();

  const base = processor.validateAndNormalize({
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    overview: 'Özet.',
    genres: [{ id: 18, name: 'Drama' }],
    keywords: [{ id: 1, name: 'twist' }],
  });

  const withPersonal = processor.validateAndNormalize({
    ...{
      id: 550,
      media_type: 'movie',
      title: 'Fight Club',
      overview: 'Özet.',
      genres: [{ id: 18, name: 'Drama' }],
      keywords: [{ id: 1, name: 'twist' }],
    },
    personal_rating: 9.9,
    notes: 'Özel kişisel notum',
    profileId: 'user-secret-profile',
  });

  assert.equal(base.valid, true);
  assert.equal(withPersonal.valid, true);
  // data_hash yalnızca temizlenmiş içerik metaverisinden üretilir; kişisel
  // alanlar hash'e dahil edilmez → iki hash aynı olmalı.
  assert.equal(base.dataHash, withPersonal.dataHash);
  assert.ok(withPersonal.strippedPersonalFields.length >= 3);
});

test('Allowlist: repository doğrudan yazımda bile allowlist sınırını uygular', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });

    repository.upsertPendingStub({
      mediaKey: 'movie:550',
      mediaType: 'movie',
      tmdbId: 550,
      sanitizedMetadata: {
        id: 550,
        title: 'Fight Club',
        overview: 'Özet.',
        profileId: 'user-secret-profile',
        personal_rating: 9.5,
        notes: 'Özel kişisel notum',
        poster_path: '/leak.jpg',
        bilinmeyen_alan: 'sızmasın',
      },
    });

    const record = repository.getByMediaKey('movie:550');
    assert.ok(record);
    const serialized = JSON.stringify(record);
    for (const needle of [
      'user-secret-profile',
      'Özel kişisel notum',
      'personal_rating',
      'poster_path',
      'leak.jpg',
      'bilinmeyen_alan',
    ]) {
      assert.equal(serialized.includes(needle), false, `Repository sızıntısı: ${needle}`);
    }

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
