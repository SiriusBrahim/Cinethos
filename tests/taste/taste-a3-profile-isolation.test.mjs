/**
 * R2-A3 — Profil izolasyonu, ProfileContext zorunluluğu ve HTTP fence testleri.
 *
 * Kapsam:
 * - createTasteRouter profil-siz kurulamaz (global fallback YOK)
 * - Aynı dataDir altında iki profilin verisi izole
 * - Gerçek geçici dizin + iki profil ile entegrasyon (mock değil)
 * - /domain-event: sunucu kimlik otoritesi (istemci profileId'si hedef seçemez)
 * - Stale revision / profil değişimi sonrası yazma engeli
 * - Legacy global Taste API uyumluluğu (davranış korunur, yönlendirme yok)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";

import { createTasteRouter } from "../../src/server/taste-routes.ts";
import { createProfileContext } from "../../src/app/ProfileContext.ts";
import { createServerTasteServiceAdapter } from "../../src/server/taste-service-adapter.ts";
import {
  readTasteEventsForProfile,
  readTasteProfileForProfile,
  writeTasteProfile,
} from "../../src/server/taste-store.ts";

const AS_OF = "2026-11-02T12:00:00.000Z";

function makeUserDoc(activeProfileId = "p1") {
  return {
    schemaVersion: 1,
    revision: 6,
    activeProfileId,
    profiles: [
      {
        id: "p1",
        name: "Profil 1",
        createdAt: AS_OF,
        items: [],
        preferences: { disliked: [], hidden: [] },
      },
      {
        id: "p2",
        name: "Profil 2",
        createdAt: AS_OF,
        items: [],
        preferences: { disliked: [], hidden: [] },
      },
    ],
  };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-r2a3-iso-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withServer(dataDir, profileContext, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/taste", createTasteRouter(dataDir, { profileContext }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/taste`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeRatingEvent(eventId = "evt-a3-1") {
  return {
    eventId,
    contentId: "movie:27205",
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: 9, ratingSource: "numeric" },
    recordedAt: AS_OF,
    experiencedAt: AS_OF,
    timeSource: "actual",
    timePrecision: "exact",
  };
}

const METADATA = {
  contentId: "movie:27205",
  mediaType: "movie",
  tmdbId: 27205,
  genreIds: [878, 53],
  releaseDate: "2010-07-15",
};

describe("R2-A3 S1 — ProfileContext zorunluluğu", () => {
  it("createTasteRouter profileContext olmadan tanımlı açık hata üretir (sessiz global fallback yok)", async () => {
    await withTempDir(async (dataDir) => {
      assert.throws(
        () => createTasteRouter(dataDir),
        /profileContext zorunludur/
      );
    });
  });

  it("kanonik olmayan aktif kimlik ('default') 409 ile reddedilir ve global okuma yapılmaz", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc(), null, 2),
        "utf8"
      );
      const context = createProfileContext({ initialProfileId: "default", initialRevision: 0 });
      await withServer(dataDir, context, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/profile`);
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.code, "invalid_profile_id");
        const eventsRes = await fetch(`${baseUrl}/events`);
        assert.strictEqual(eventsRes.status, 409);
      });
      assert.strictEqual(
        fs.existsSync(path.join(dataDir, "taste", "cinetrack-taste-profile.json")),
        false
      );
    });
  });
});

describe("R2-A3 S1/S5 — Aynı dataDir altında iki profil izolasyonu", () => {
  it("p1'e yazılan olay p2'ye görünmez; profiller ayrı HTTP yanıtı üretir", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );

      const ctx1 = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      const ctx2 = createProfileContext({ initialProfileId: "p2", initialRevision: 6 });

      await withServer(dataDir, ctx1, async (baseUrl) => {
        const res = await postJson(`${baseUrl}/event`, {
          event: makeRatingEvent("evt-p1-1"),
          metadata: METADATA,
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.added, true);

        const events = await fetch(`${baseUrl}/events`).then((r) => r.json());
        assert.deepEqual(events.events.map((e) => e.eventId), ["evt-p1-1"]);

        const profileRes = await fetch(`${baseUrl}/profile`);
        assert.strictEqual(profileRes.status, 200);
        const profile = await profileRes.json();
        assert.ok(profile.metrics["genre.scifi"], "p1 profili skor üretmeli");
      });

      await withServer(dataDir, ctx2, async (baseUrl) => {
        const events = await fetch(`${baseUrl}/events`).then((r) => r.json());
        assert.strictEqual(events.count, 0, "p2 p1'in olaylarını görmemeli");
        const profileRes = await fetch(`${baseUrl}/profile`);
        assert.strictEqual(profileRes.status, 404, "p2 için profil henüz yok");
      });

      assert.deepEqual(
        (await readTasteEventsForProfile("p1", dataDir)).map((e) => e.eventId),
        ["evt-p1-1"]
      );
      assert.deepEqual(await readTasteEventsForProfile("p2", dataDir), []);
      assert.strictEqual(await readTasteProfileForProfile("p2", dataDir), null);
    });
  });

  it("override yalnızca aktif profilin store'una yazılır", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );
      const ctx1 = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      await withServer(dataDir, ctx1, async (baseUrl) => {
        await postJson(`${baseUrl}/event`, {
          event: makeRatingEvent("evt-p1-ovr"),
          metadata: METADATA,
        });
        const res = await postJson(`${baseUrl}/override`, {
          metricId: "genre.scifi",
          value: 12,
          mode: "replace",
        });
        assert.strictEqual(res.status, 200);
      });

      const p1 = await readTasteProfileForProfile("p1", dataDir);
      assert.strictEqual(p1.metrics["genre.scifi"].manualOverride.mode, "replace");
      assert.strictEqual(await readTasteProfileForProfile("p2", dataDir), null);
    });
  });

  it("manifest ve rebuild uçları profil kapsamlı çalışır", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );
      const ctx1 = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      await withServer(dataDir, ctx1, async (baseUrl) => {
        await postJson(`${baseUrl}/event`, {
          event: makeRatingEvent("evt-p1-manifest"),
          metadata: METADATA,
        });
        const manifestRes = await fetch(`${baseUrl}/manifest`);
        assert.strictEqual(manifestRes.status, 200);
        const manifest = await manifestRes.json();
        assert.ok(manifest.generationId);
        assert.ok(
          manifest.files.profile.includes(path.join("profiles")),
          "manifest profil kapsamlı dosyaları göstermeli"
        );

        const rebuildRes = await postJson(`${baseUrl}/rebuild`, {});
        assert.strictEqual(rebuildRes.status, 200);
        const rebuildBody = await rebuildRes.json();
        assert.strictEqual(rebuildBody.success, true);

        const overviewRes = await fetch(`${baseUrl}/overview`);
        assert.strictEqual(overviewRes.status, 200);
        const overview = await overviewRes.json();
        assert.strictEqual(overview.eventsCount, 1);
      });
      assert.strictEqual(
        fs.existsSync(path.join(dataDir, "taste", "cinetrack-taste-profile.json")),
        false,
        "legacy global profile dosyası oluşturulmamalı"
      );
    });
  });
});

describe("R2-A3 S4/S5 — Domain event kimlik otoritesi ve revision fence", () => {
  function makeDomainEvent(overrides = {}) {
    return {
      eventId: "dom-1",
      eventType: "LibraryItemAdded",
      profileId: "p1",
      entityId: "movie:27205",
      occurredAt: AS_OF,
      schemaVersion: 1,
      sourceRevision: 6,
      payload: { list: "watched", mediaKey: "movie:27205" },
      ...overrides,
    };
  }

  it("istemcinin farklı profileId'si 409 ile reddedilir, hedef store'a yazılmaz", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );
      const ctx = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      await withServer(dataDir, ctx, async (baseUrl) => {
        const res = await postJson(`${baseUrl}/domain-event`, makeDomainEvent({ profileId: "p2" }));
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.code, "profile-switched");
      });
      assert.deepEqual(await readTasteEventsForProfile("p2", dataDir), []);
      assert.deepEqual(await readTasteEventsForProfile("p1", dataDir), []);
    });
  });

  it("eski sourceRevision 409 üretir; güncel revision idempotent yazılır", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );
      const ctx = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      await withServer(dataDir, ctx, async (baseUrl) => {
        const stale = await postJson(
          `${baseUrl}/domain-event`,
          makeDomainEvent({ sourceRevision: 3 })
        );
        assert.strictEqual(stale.status, 409);

        const ok = await postJson(`${baseUrl}/domain-event`, makeDomainEvent());
        assert.strictEqual(ok.status, 200);

        const again = await postJson(`${baseUrl}/domain-event`, makeDomainEvent());
        assert.strictEqual(again.status, 200);
      });
      const events = await readTasteEventsForProfile("p1", dataDir);
      assert.deepEqual(events.map((e) => e.eventId), ["dom-1"]);
    });
  });

  it("profil değişiminden sonra eski ref ile yazma reddedilir (assertWritable)", async () => {
    const ctx = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
    const staleRef = ctx.getCurrent();
    await ctx.switchProfile("p2", 7);
    assert.throws(
      () => ctx.assertWritable(staleRef),
      (error) => error && error.reason === "profile-switched"
    );
  });

  it("adapter: yanlış profil ve stale revision yazma yapmaz, refreshProfile eski ref'i reddeder", async () => {
    await withTempDir(async (dataDir) => {
      const ctx = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      const adapter = createServerTasteServiceAdapter({
        dataDir,
        profileContext: ctx,
        rebuildOnEvent: false,
      });

      const mismatch = await adapter.processEvent(makeDomainEvent({ profileId: "p2" }));
      assert.strictEqual(mismatch.ok, false);
      assert.strictEqual(mismatch.retryable, false);
      assert.deepEqual(await readTasteEventsForProfile("p2", dataDir), []);

      const stale = await adapter.processEvent(makeDomainEvent({ sourceRevision: 2 }));
      assert.strictEqual(stale.ok, false);
      assert.deepEqual(await readTasteEventsForProfile("p1", dataDir), []);

      const okEvent = await adapter.processEvent(makeDomainEvent());
      assert.strictEqual(okEvent.ok, true);
      assert.deepEqual(
        (await readTasteEventsForProfile("p1", dataDir)).map((e) => e.eventId),
        ["dom-1"]
      );

      const oldRef = ctx.getCurrent();
      const refreshOk = await adapter.refreshProfile(oldRef);
      assert.strictEqual(refreshOk.ok, true);

      await ctx.switchProfile("p2", 9);
      const staleRefresh = await adapter.refreshProfile(oldRef);
      assert.strictEqual(staleRefresh.ok, false);
      assert.strictEqual(staleRefresh.retryable, false);
    });
  });
});

describe("R2-A3 S7 — Legacy global API uyumluluğu", () => {
  it("global API davranışı korunur; profil uçları global veriye yönlenmez veya onu değiştirmez", async () => {
    await withTempDir(async (dataDir) => {
      fs.writeFileSync(
        path.join(dataDir, "cinetrack-data.json"),
        JSON.stringify(makeUserDoc("p1"), null, 2),
        "utf8"
      );
      const legacyProfile = {
        mediaType: "movie",
        algorithmVersion: "v1.0",
        taxonomyVersion: "v0.1",
        asOf: AS_OF,
        profileName: "Legacy",
        metrics: {
          "genre.drama": {
            metricId: "genre.drama",
            affinity: 42,
            longTermAffinity: 42,
            recentAffinity: 42,
            status: "directional",
            evidence: {
              posMass: 2,
              negMass: 0,
              uncertainMass: 0,
              topPositiveContentIds: ["movie:1"],
              topNegativeContentIds: [],
            },
          },
        },
      };
      await writeTasteProfile(legacyProfile, dataDir);
      const legacyPath = path.join(dataDir, "taste", "cinetrack-taste-profile.json");
      const legacyRaw = fs.readFileSync(legacyPath, "utf8");

      const ctx = createProfileContext({ initialProfileId: "p1", initialRevision: 6 });
      await withServer(dataDir, ctx, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/profile`);
        assert.strictEqual(res.status, 200);
        const profile = await res.json();
        assert.strictEqual(
          profile.metrics["genre.drama"].affinity,
          0,
          "profil ucu legacy global profile yönlenmemeli (legacy affinity 42)"
        );
        await postJson(`${baseUrl}/event`, {
          event: makeRatingEvent("evt-legacy"),
          metadata: METADATA,
        });
      });

      assert.strictEqual(
        fs.readFileSync(legacyPath, "utf8"),
        legacyRaw,
        "legacy global dosya bayt-bayt korunmalı (otomatik dağıtım yok)"
      );
      const globalAgain = JSON.parse(legacyRaw);
      assert.strictEqual(globalAgain.profileName, "Legacy");
    });
  });
});
