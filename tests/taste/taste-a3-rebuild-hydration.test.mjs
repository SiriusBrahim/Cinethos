/**
 * R2-A3 — Bootstrap hedef profili, profil kapsamlı rebuild, manifest/watermark
 * ve hydration (shared cache ↔ profil index) testleri.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyHydrationRound,
  ensureInitialTasteBootstrap,
  hydrateProfileTasteIndex,
  seedProfileIndexFromCache,
  triggerTasteProfileRebuild,
  upsertTasteMetadataInputs,
} from "../../src/server/taste-rebuild-coordinator.ts";
import {
  readTasteEventsForProfile,
  readTasteIndexForProfile,
  readTasteManifestForProfile,
  readTasteProfileForProfile,
  resolveTastePathsForProfile,
  writeTasteEventsForProfile,
} from "../../src/server/taste-store.ts";
import {
  resolveTasteMetadataCachePath,
  writeTasteMetadataCache,
} from "../../src/server/taste-metadata-hydrator.ts";
import { projectLearningSnapshot } from "../../src/core/taste/taste-event-projector.ts";

const AS_OF = "2026-11-02T12:00:00.000Z";

function makeEvent(eventId, contentId, newValue = 9) {
  return {
    eventId,
    contentId,
    eventType: "rating_changed",
    payload: { previousValue: null, newValue, ratingSource: "numeric" },
    recordedAt: AS_OF,
    experiencedAt: AS_OF,
    timeSource: "actual",
    timePrecision: "exact",
  };
}

function makeUserDoc(activeProfileId, items = []) {
  return {
    schemaVersion: 1,
    revision: 6,
    activeProfileId,
    profiles: [
      { id: "p1", name: "Profil 1", createdAt: AS_OF, items, preferences: { disliked: [], hidden: [] } },
      { id: "p2", name: "Profil 2", createdAt: AS_OF, items: [], preferences: { disliked: [], hidden: [] } },
    ],
  };
}

function writeUserDoc(dataDir, doc) {
  fs.writeFileSync(path.join(dataDir, "cinetrack-data.json"), JSON.stringify(doc, null, 2), "utf8");
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-r2a3-coord-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cachedMeta(contentId, tmdbId) {
  return {
    contentId,
    mediaType: contentId.startsWith("tv:") ? "tv" : "movie",
    tmdbId,
    genreIds: [878, 53],
    keywords: [{ id: 1, name: "space" }],
    fetchedAt: AS_OF,
    source: "tmdb",
  };
}

describe("R2-A3 S2 — Bootstrap hedef profil güvenliği", () => {
  it("belgenin aktif profili farklıysa bootstrap hiçbir şey yazmaz (profiles[0] fallback yok)", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p2"));
      await ensureInitialTasteBootstrap("p1", dataDir);

      const paths = resolveTastePathsForProfile("p1", dataDir).paths;
      assert.strictEqual(fs.existsSync(paths.profile), false);
      assert.strictEqual(fs.existsSync(paths.events), false);
      assert.strictEqual(await readTasteProfileForProfile("p1", dataDir), null);
      assert.deepEqual(await readTasteEventsForProfile("p1", dataDir), []);
    });
  });

  it("eşleşen profil için bootstrap profil kapsamlı yazar", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p2"));
      await ensureInitialTasteBootstrap("p2", dataDir);

      const profile = await readTasteProfileForProfile("p2", dataDir);
      assert.ok(profile, "p2 profili bootstrap sonrası oluşmalı");
      assert.ok(profile.metrics, "bootstrap profili metrik haritası üretmeli");
      assert.strictEqual(await readTasteProfileForProfile("p1", dataDir), null);
    });
  });

  it("geçersiz profil kimliği bootstrap'ta açık hata fırlatır", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      await assert.rejects(
        () => ensureInitialTasteBootstrap("default", dataDir),
        /PROFILE_ID_PATTERN|uyumuyor|kimliği/
      );
    });
  });
});

describe("R2-A3 S3 — Profil kapsamlı rebuild, manifest ve watermark", () => {
  it("aynı dataDir altında iki profilin rebuild verisi birbirini etkilemez", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      await writeTasteEventsForProfile("p1", [makeEvent("p1-e1", "movie:27205")], dataDir);
      await writeTasteEventsForProfile("p2", [makeEvent("p2-e1", "tv:1399", 4)], dataDir);

      await upsertTasteMetadataInputs(
        "p1",
        [{ contentId: "movie:27205", mediaType: "movie", tmdbId: 27205, genreIds: [878] }],
        dataDir
      );
      await upsertTasteMetadataInputs(
        "p2",
        [{ contentId: "tv:1399", mediaType: "tv", tmdbId: 1399, genreIds: [18] }],
        dataDir
      );

      const p2ManifestBefore = await readTasteManifestForProfile("p2", dataDir);

      await triggerTasteProfileRebuild("p1", dataDir);

      const p1 = await readTasteProfileForProfile("p1", dataDir);
      const p2 = await readTasteProfileForProfile("p2", dataDir);
      assert.ok(p1);
      assert.ok(p1.metrics["genre.scifi"], "p1 kendi index'inden skor üretmeli");
      assert.strictEqual(p2, null, "p1 rebuild'i p2 profili oluşturmamalı");

      const p1Index = await readTasteIndexForProfile("p1", dataDir);
      const p2Index = await readTasteIndexForProfile("p2", dataDir);
      assert.ok(p1Index.items["movie:27205"]);
      assert.ok(p2Index.items["tv:1399"]);
      assert.strictEqual(p1Index.items["tv:1399"], undefined, "index'ler izole olmalı");

      const p1Manifest = await readTasteManifestForProfile("p1", dataDir);
      const p2Manifest = await readTasteManifestForProfile("p2", dataDir);
      assert.ok(p1Manifest);
      assert.ok(p2ManifestBefore, "p2 index yazımı kendi manifest'ini üretir");
      assert.strictEqual(
        p2Manifest.generationId,
        p2ManifestBefore.generationId,
        "p1 rebuild'i p2 manifest'ini yeniden yazmamalı"
      );
      assert.strictEqual(
        p1Manifest.eventWatermark,
        projectLearningSnapshot([makeEvent("p1-e1", "movie:27205")]).eventWatermark,
        "manifest event watermark rebuild girdisiyle aynı olmalı"
      );
    });
  });

  it("metadata upsert yalnızca hedef profilin index'ini büyütür", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      const stats = await upsertTasteMetadataInputs(
        "p2",
        [{ contentId: "movie:550", mediaType: "movie", tmdbId: 550, genreIds: [18] }],
        dataDir
      );
      assert.strictEqual(stats.created, 1);
      assert.ok((await readTasteIndexForProfile("p2", dataDir)).items["movie:550"]);
      assert.strictEqual(await readTasteIndexForProfile("p1", dataDir), null);
    });
  });
});

describe("R2-A3 S6 — Shared metadata cache ve profil index ayrımı", () => {
  it("cache hit tek başına yetmez: API anahtarı yokluğu ayrı raporlanır ve index cache'ten tohumlanır", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      await writeTasteMetadataCache(
        {
          schemaVersion: 1,
          updatedAt: AS_OF,
          items: { "movie:27205": cachedMeta("movie:27205", 27205) },
        },
        dataDir
      );

      const seeded = await seedProfileIndexFromCache("p1", dataDir, ["movie:27205", "movie:999"]);
      assert.strictEqual(seeded, 1);
      const index = await readTasteIndexForProfile("p1", dataDir);
      assert.ok(index.items["movie:27205"]);
      assert.strictEqual(index.items["movie:999"], undefined);

      const outcome = await hydrateProfileTasteIndex("p1", dataDir, ["movie:27205"]);
      assert.strictEqual(outcome.stopReason, "no-api-key");
      assert.strictEqual(outcome.seededFromCache, 0, "index zaten güncel olduğu için yeniden yazım yok");
      assert.strictEqual(outcome.fetched, 0);
    });
  });

  it("cache hit turu yeni profilin index'ini oluşturur; shared cache tek dosyada kalır", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      await writeTasteMetadataCache(
        {
          schemaVersion: 1,
          updatedAt: AS_OF,
          items: { "movie:27205": cachedMeta("movie:27205", 27205) },
        },
        dataDir
      );

      const outcome = await hydrateProfileTasteIndex("p2", dataDir, ["movie:27205"]);
      assert.strictEqual(outcome.seededFromCache, 1);
      assert.strictEqual(outcome.stopReason, "no-api-key");

      const p2Index = await readTasteIndexForProfile("p2", dataDir);
      assert.ok(p2Index.items["movie:27205"], "cache hit yeni profilin index'ini üretmeli");
      assert.strictEqual(await readTasteIndexForProfile("p1", dataDir), null);

      const cachePath = resolveTasteMetadataCachePath(dataDir);
      assert.ok(fs.existsSync(cachePath));
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      assert.ok(cache.items["movie:27205"], "shared cache korunmalı");

      const p1Paths = resolveTastePathsForProfile("p1", dataDir).paths;
      const p2Paths = resolveTastePathsForProfile("p2", dataDir).paths;
      assert.notEqual(p1Paths.index, p2Paths.index, "index dosyaları profil kapsamlı olmalı");
    });
  });

  it("eşzamanlı iki profil hidrasyonu birbirinin index'ini bozmaz", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      await writeTasteMetadataCache(
        {
          schemaVersion: 1,
          updatedAt: AS_OF,
          items: {
            "movie:27205": cachedMeta("movie:27205", 27205),
            "tv:1399": cachedMeta("tv:1399", 1399),
          },
        },
        dataDir
      );

      const [a, b] = await Promise.all([
        hydrateProfileTasteIndex("p1", dataDir, ["movie:27205"]),
        hydrateProfileTasteIndex("p2", dataDir, ["tv:1399"]),
      ]);
      assert.strictEqual(a.seededFromCache, 1);
      assert.strictEqual(b.seededFromCache, 1);

      const p1Index = await readTasteIndexForProfile("p1", dataDir);
      const p2Index = await readTasteIndexForProfile("p2", dataDir);
      assert.ok(p1Index.items["movie:27205"]);
      assert.strictEqual(p1Index.items["tv:1399"], undefined);
      assert.ok(p2Index.items["tv:1399"]);
      assert.strictEqual(p2Index.items["movie:27205"], undefined);
    });
  });

  it("hidrasyon turu sınıflandırması: cache-only, fetch-failed ve progress ayrıdır", () => {
    assert.strictEqual(
      classifyHydrationRound({ fetched: 0, failed: 0, remaining: 0 }),
      "cache-only"
    );
    assert.strictEqual(
      classifyHydrationRound({ fetched: 0, failed: 3, remaining: 12 }),
      "fetch-failed"
    );
    assert.strictEqual(
      classifyHydrationRound({ fetched: 4, failed: 1, remaining: 8 }),
      "progress"
    );
  });

  it("içerik yoksa hidrasyon no-content döner ve yazım yapmaz", async () => {
    await withTempDir(async (dataDir) => {
      writeUserDoc(dataDir, makeUserDoc("p1"));
      const outcome = await hydrateProfileTasteIndex("p1", dataDir, []);
      assert.strictEqual(outcome.stopReason, "no-content");
      assert.strictEqual(await readTasteIndexForProfile("p1", dataDir), null);
    });
  });
});
