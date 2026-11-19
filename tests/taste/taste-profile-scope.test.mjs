/**
 * Faz 5 — R2-A1 Profil Kapsamı Testleri
 *
 * PR #32 §3 kabul kriterlerinin kalıcı otomatik test karşılıkları:
 *   §3.1 kimlik/path güvenliği, §3.2 manifest doğruluğu/bütünlüğü,
 *   §3.3 eşzamanlılık ve ilk oluşturma, §3.4 bozuk veri davranışı,
 *   §3.5 uyumluluk ve regresyon.
 *
 * Not: Gerçek disk yazımı yapılır → her test kendi geçici dizinini kullanır.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROFILE_ID_PATTERN } from "../../src/core/profile-id.ts";
import {
  TASTE_PATHS,
  TASTE_PROFILE_ID_MAP_FILENAME,
  TASTE_PROFILE_ID_MAP_SCHEME,
  TASTE_PROFILE_ID_MAX_LENGTH,
  appendTasteEvent,
  decodeProfileIdSafe,
  encodeProfileIdSafe,
  ensureTasteProfileIdMapEntry,
  parseTasteProfileIdMap,
  readTasteProfileIdMap,
  readTasteProfileIdMapEntry,
  resolveTastePaths,
  resolveTastePathsForProfile,
  resolveTasteProfileIdMapPath,
  resolveTasteProfilesRoot,
  validateCanonicalProfileId,
  writeTasteProfile,
} from "../../src/server/taste-store.ts";

const AS_OF = "2026-11-02T00:00:00.000Z";

async function makeDataDir() {
  return mkdtemp(join(tmpdir(), "ct-taste-scope-"));
}

function makeProfile() {
  return {
    mediaType: "movie",
    algorithmVersion: "v1.0",
    taxonomyVersion: "v0.1",
    asOf: AS_OF,
    metrics: {},
  };
}

function preEncodedDir(profileId) {
  return encodeProfileIdSafe(profileId);
}

function makeMap(profileIds) {
  const entries = {};
  const byDir = {};
  for (const profileId of profileIds) {
    const dir = preEncodedDir(profileId);
    entries[profileId] = { dir, createdAt: AS_OF };
    byDir[dir] = profileId;
  }
  return { version: 2, scheme: TASTE_PROFILE_ID_MAP_SCHEME, entries, byDir };
}

function expectScopeError(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "Hata fırlatılmalıydı");
  assert.strictEqual(thrown.code, code, `Beklenen kod ${code}, alınan ${thrown.code}`);
  return thrown;
}

// === §3.1 Kimlik ve path güvenliği ===

describe("R2-A1 — §3.1 Kanonik profil kimliği", () => {
  it("Mevcut PROFILE_ID_PATTERN sözleşmesine uyan kimlikler kabul edilir", () => {
    for (const id of [
      "profile-default",
      "profile-a",
      "profile-A_b-9",
      "p1",
      "p1234567890",
    ]) {
      assert.strictEqual(validateCanonicalProfileId(id), id.toUpperCase());
      assert.ok(PROFILE_ID_PATTERN.test(id), `${id} sözleşmeye uymalı`);
    }
  });

  it("Boş, trim-sonrası boş ve tip dışı değerler fail-fast reddedilir", () => {
    for (const bad of ["", "   ", "\t\n", null, undefined, 42, {}, []]) {
      expectScopeError(() => validateCanonicalProfileId(bad), "invalid_profile_id");
    }
  });

  it("'.', '..', yol ayıracı ve kontrol karakterleri reddedilir", () => {
    for (const bad of [".", "..", "../profile-default", "a/b", "a\\b"]) {
      expectScopeError(() => validateCanonicalProfileId(bad), "invalid_profile_id");
    }
  });

  it("Baştaki/sondaki boşluk trim edilir, kontrol karakterli kimlik reddedilir", () => {
    assert.strictEqual(validateCanonicalProfileId("  p1  "), "P1");
    for (const bad of ["p1\n", "\tp1", "p1\u0000", "p1\u007f"]) {
      expectScopeError(() => validateCanonicalProfileId(bad), "invalid_profile_id");
    }
  });

  it("Sözleşme dışı biçim ve uzunluk üst sınırı reddedilir", () => {
    for (const bad of [
      "unknown",
      "profile-",
      "profile_1",
      "profile-",
      `profile-${"a".repeat(61)}`,
      "p12345678901",
      `p1${"0".repeat(TASTE_PROFILE_ID_MAX_LENGTH)}`,
    ]) {
      expectScopeError(() => validateCanonicalProfileId(bad), "invalid_profile_id");
    }
  });

  it("Kabul/ret kararı PROFILE_ID_PATTERN ile aynı sözleşmeyi izler", () => {
    const samples = ["profile-default", "p7", "P1", "profile-", "p", "x", "profile-a b"];
    for (const sample of samples) {
      const acceptedByPattern = PROFILE_ID_PATTERN.test(sample);
      let accepted = true;
      try {
        validateCanonicalProfileId(sample);
      } catch {
        accepted = false;
      }
      assert.strictEqual(accepted, acceptedByPattern, `Sözleşme sapması: ${sample}`);
    }
  });
});

describe("R2-A1 — §3.1 p2-hex kodlama", () => {
  it("Kayıpsız encode/decode round-trip sağlar", () => {
    for (const id of ["profile-default", "p1", "profile-A_b-9", "p1234567890"]) {
      const dir = encodeProfileIdSafe(id);
      assert.ok(dir.startsWith(`${TASTE_PROFILE_ID_MAP_SCHEME}-`), "şema öneki eksik");
      assert.match(dir, /^p2-hex-[0-9a-f]+$/);
      assert.strictEqual(decodeProfileIdSafe(dir), id.toUpperCase());
      assert.strictEqual(encodeProfileIdSafe(decodeProfileIdSafe(dir)), dir);
    }
  });

  it("Desen-geçerli kimlik uzayında round-trip ve alfabe kuralı korunur (TC-1)", () => {
    const ids = [];
    for (let i = 1; i <= 12; i += 1) ids.push(`p${i}`);
    for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") {
      ids.push(`profile-x${ch}`);
      ids.push(`profile-${ch}x`);
    }
    ids.push(`profile-${"a".repeat(60)}`);
    ids.push("profile-" + "A1_b-9".repeat(8));

    for (const id of ids) {
      assert.match(id, PROFILE_ID_PATTERN, `fixture desen dışı: ${id}`);
      const dir = encodeProfileIdSafe(id);
      assert.match(dir, /^p2-hex-[0-9a-f]+$/, `dizin alfabesi hatalı: ${dir}`);
      assert.ok(!dir.includes("=") && !dir.includes("+") && !dir.includes("/"));
      assert.strictEqual(decodeProfileIdSafe(dir), id.toUpperCase());
    }
  });

  it("Kodlama sanitize/replace değildir: farklı kimlikler farklı dizin üretir", () => {
    const dirs = new Set(
      ["profile-default", "profile-default2", "p1", "p2"].map((id) => encodeProfileIdSafe(id))
    );
    assert.strictEqual(dirs.size, 4);
  });

  it("Şema dışı, bozuk alfabe ve round-trip sapması fail-fast reddedilir", () => {
    for (const dir of [
      "b64url-cHJvZmlsZS1kZWZhdWx0",
      "p1-b64url-",
      "p1-b64url-!!!",
      "p1-b64url-cHJvZmlsZS1kZWZhdWx0=",
      "p2-hex-",
      "p2-hex-abc",
      "p2-hex-2e2e2f657363617065",
      null,
    ]) {
      expectScopeError(() => decodeProfileIdSafe(dir), "invalid_profile_dir");
    }
  });
});

describe("R2-A1 — §3.1 Profil yolu kök sınırı", () => {
  it("Çözümlenen profil yolları taste kökü içinde kalır", async () => {
    const dataDir = await makeDataDir();
    const scope = resolveTastePathsForProfile("profile-default", dataDir);
    const profilesRoot = resolveTasteProfilesRoot(dataDir);

    assert.ok(scope.root.startsWith(profilesRoot), "profil kökü profiles altında olmalı");
    assert.strictEqual(scope.dir, encodeProfileIdSafe("profile-default"));
    assert.strictEqual(decodeProfileIdSafe(scope.dir), "PROFILE-DEFAULT");
    for (const [key, filePath] of Object.entries(scope.paths)) {
      assert.ok(filePath.startsWith(`${scope.root}/`), `${key} profil kökü dışında`);
      assert.ok(filePath.includes("cinetrack-taste-"), `${key} dosya adı beklenen biçimde değil`);
    }
  });

  it("Geçersiz kimlikte yol çözümleme yapılmaz", async () => {
    const dataDir = await makeDataDir();
    expectScopeError(() => resolveTastePathsForProfile("../escape", dataDir), "invalid_profile_id");
  });
});

// === §3.2 Manifest doğruluğu ve bütünlüğü ===

describe("R2-A1 — §3.2 Manifest şeması ve bütünlüğü", () => {
  it("Geçerli manifest version/scheme/entries/byDir ile doğrulanır", () => {
    const parsed = parseTasteProfileIdMap(makeMap(["profile-default", "p1"]));
    assert.strictEqual(parsed.version, 2);
    assert.strictEqual(parsed.scheme, TASTE_PROFILE_ID_MAP_SCHEME);
    assert.strictEqual(Object.keys(parsed.entries).length, 2);
    assert.strictEqual(Object.keys(parsed.byDir).length, 2);
  });

  it("entries ↔ byDir birebir değilse fail-fast hata üretir", () => {
    const missingByDir = makeMap(["profile-default"]);
    delete missingByDir.byDir[preEncodedDir("profile-default")];
    expectScopeError(() => parseTasteProfileIdMap(missingByDir), "profile_id_map_corrupt");

    const extraByDir = makeMap(["profile-default"]);
    extraByDir.byDir[preEncodedDir("p1")] = "p1";
    expectScopeError(() => parseTasteProfileIdMap(extraByDir), "profile_id_map_corrupt");

    const wrongTarget = makeMap(["profile-default", "p1"]);
    wrongTarget.byDir[preEncodedDir("p1")] = "profile-default";
    expectScopeError(() => parseTasteProfileIdMap(wrongTarget), "profile_id_map_corrupt");
  });

  it("Aynı canonical id farklı dir / aynı dir farklı id çakışması reddedilir", () => {
    const mismatchedDir = makeMap(["profile-default"]);
    mismatchedDir.entries["profile-default"].dir = preEncodedDir("p1");
    expectScopeError(() => parseTasteProfileIdMap(mismatchedDir), "profile_id_map_corrupt");
  });

  it("Şema/sürüm uyumsuzluğu ve bozuk alanlar fail-fast reddedilir", () => {
    const badVersion = { ...makeMap(["p1"]), version: 99 };
    expectScopeError(() => parseTasteProfileIdMap(badVersion), "profile_id_map_corrupt");

    const badScheme = { ...makeMap(["p1"]), scheme: "p1-b64url" };
    expectScopeError(() => parseTasteProfileIdMap(badScheme), "profile_id_map_corrupt");

    const badCreatedAt = makeMap(["p1"]);
    badCreatedAt.entries["p1"].createdAt = "not-a-date";
    expectScopeError(() => parseTasteProfileIdMap(badCreatedAt), "profile_id_map_corrupt");

    const nonCanonicalKey = makeMap(["p1"]);
    nonCanonicalKey.entries[" p1"] = nonCanonicalKey.entries["p1"];
    expectScopeError(() => parseTasteProfileIdMap(nonCanonicalKey), "profile_id_map_corrupt");

    expectScopeError(() => parseTasteProfileIdMap([]), "profile_id_map_corrupt");
    expectScopeError(() => parseTasteProfileIdMap(null), "profile_id_map_corrupt");
  });
});

// === §3.3 Eşzamanlılık ve ilk oluşturma ===

describe("R2-A1 — §3.3 Manifest ilk oluşturma ve eşzamanlılık", () => {
  it("Manifest yokken ilk kayıt kilitli/atomik oluşturulur", async () => {
    const dataDir = await makeDataDir();
    const mapPath = resolveTasteProfileIdMapPath(dataDir);

    assert.deepStrictEqual(await readTasteProfileIdMap(dataDir), {
      status: "missing",
      data: null,
    });

    const first = await ensureTasteProfileIdMapEntry("profile-default", dataDir);
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.dir, encodeProfileIdSafe("profile-default"));
    assert.ok(existsSync(mapPath), "manifest yazılmalı");

    const raw = JSON.parse(await readFile(mapPath, "utf8"));
    assert.strictEqual(raw.version, 2);
    assert.strictEqual(raw.scheme, TASTE_PROFILE_ID_MAP_SCHEME);
    assert.strictEqual(Object.keys(raw.entries).length, 1);
    assert.strictEqual(raw.entries["PROFILE-DEFAULT"].dir, first.dir);
    assert.strictEqual(raw.byDir[first.dir], "PROFILE-DEFAULT");
  });

  it("Aynı kimlik için ikinci çağrı idempotenttir (createdAt korunur)", async () => {
    const dataDir = await makeDataDir();
    const first = await ensureTasteProfileIdMapEntry("p1", dataDir);
    const second = await ensureTasteProfileIdMapEntry("p1", dataDir);

    assert.strictEqual(first.created, true);
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.dir, first.dir);
    assert.strictEqual(second.createdAt, first.createdAt);
  });

  it("Eşzamanlı ilk erişimde yarışsız tek manifest ve birebir eşleme sağlanır", async () => {
    const dataDir = await makeDataDir();
    const ids = ["profile-a", "profile-b", "p1", "p2", "profile-c", "p3"];

    const results = await Promise.all(
      ids.map((id) => ensureTasteProfileIdMapEntry(id, dataDir))
    );

    assert.strictEqual(results.filter((r) => r.created).length, ids.length);

    const map = await readTasteProfileIdMap(dataDir);
    assert.strictEqual(map.status, "ok");
    assert.strictEqual(Object.keys(map.data.entries).length, ids.length);
    assert.strictEqual(Object.keys(map.data.byDir).length, ids.length);
    for (const id of ids) {
      const canonicalId = id.toUpperCase();
      const entry = map.data.entries[canonicalId];
      assert.ok(entry, `${canonicalId} manifestte yok`);
      assert.strictEqual(map.data.byDir[entry.dir], canonicalId);
      assert.strictEqual(decodeProfileIdSafe(entry.dir), canonicalId);
    }

    const lookup = await readTasteProfileIdMapEntry("p2", dataDir);
    assert.strictEqual(lookup?.profileId, "P2");
    assert.strictEqual(await readTasteProfileIdMapEntry("p9", dataDir), null);
  });
});

// === §3.4 Bozuk veri ve hata davranışı ===

describe("R2-A1 — §3.4 Bozuk manifest davranışı", () => {
  it("Bozuk JSON fail-fast hata üretir ve dosya onarılmaz/ezilmez", async () => {
    const dataDir = await makeDataDir();
    const mapPath = resolveTasteProfileIdMapPath(dataDir);
    await mkdir(join(mapPath, ".."), { recursive: true });
    const corrupt = "{ bozuk manifest";
    await writeFile(mapPath, corrupt, "utf8");

    await assert.rejects(
      () => readTasteProfileIdMap(dataDir),
      (err) => err?.code === "profile_id_map_corrupt"
    );
    assert.strictEqual(await readFile(mapPath, "utf8"), corrupt, "bozuk dosya değiştirilmemeli");

    await assert.rejects(
      () => ensureTasteProfileIdMapEntry("p1", dataDir),
      (err) => err?.code === "profile_id_map_corrupt"
    );
    assert.strictEqual(await readFile(mapPath, "utf8"), corrupt, "bozuk dosya yazılmamalı");
  });

  it("Uyumsuz sürüm/şema otomatik dönüştürülmez", async () => {
    const dataDir = await makeDataDir();
    const mapPath = resolveTasteProfileIdMapPath(dataDir);
    await mkdir(join(mapPath, ".."), { recursive: true });
    await writeFile(
      mapPath,
      JSON.stringify({ ...makeMap(["p1"]), version: 99 }),
      "utf8"
    );

    await assert.rejects(
      () => ensureTasteProfileIdMapEntry("p1", dataDir),
      (err) => err?.code === "profile_id_map_corrupt"
    );
    const raw = JSON.parse(await readFile(mapPath, "utf8"));
    assert.strictEqual(raw.version, 99, "sürüm sessizce değiştirilmemeli");
  });
});

// === §3.5 Uyumluluk ve regresyon ===

describe("R2-A1 — §3.5 TASTE_PATHS / Taste API uyumluluğu", () => {
  it("resolveTastePaths çıktısı değişmedi", () => {
    assert.deepStrictEqual(resolveTastePaths("data"), {
      taxonomy: "data/taste/cinetrack-taste-taxonomy.json",
      index: "data/taste/cinetrack-taste-index.json",
      events: "data/taste/cinetrack-taste-events.json",
      profile: "data/taste/cinetrack-taste-profile.json",
      manifest: "data/taste/cinetrack-taste-manifest.json",
      objections: "data/taste/cinetrack-taste-objections.json",
    });
    const custom = resolveTastePaths("/tmp/cinetrack-test");
    assert.strictEqual(custom.events, join("/tmp/cinetrack-test", "taste", "cinetrack-taste-events.json"));
    assert.deepStrictEqual(TASTE_PATHS, resolveTastePaths("data"));
  });

  it("Profil eşleme manifesti legacy dosyaların yanına yazılmaz", () => {
    const mapPath = resolveTasteProfileIdMapPath("data");
    assert.strictEqual(mapPath, join("data", "taste", "profiles", TASTE_PROFILE_ID_MAP_FILENAME));
    assert.ok(!mapPath.includes("cinetrack-taste-profile.json"));
  });

  it("Legacy store yazımları çalışır ve kilit dosyası bırakmaz (davranış korunur)", async () => {
    const dataDir = await makeDataDir();

    await appendTasteEvent(
      {
        eventId: "scope-compat-1",
        contentId: "movie:550",
        eventType: "rating_changed",
        payload: { previousValue: null, newValue: 8 },
        recordedAt: AS_OF,
        timeSource: "actual",
        timePrecision: "exact",
      },
      dataDir
    );
    await writeTasteProfile(makeProfile(), dataDir);

    const paths = resolveTastePaths(dataDir);
    assert.ok(existsSync(paths.events), "events yazılmalı");
    assert.ok(existsSync(paths.profile), "profile yazılmalı");
    assert.ok(existsSync(paths.manifest), "manifest yazılmalı");
    assert.strictEqual(existsSync(join(dataDir, "taste", ".taste.lock")), false, ".taste.lock kaldı");

    const profile = JSON.parse(await readFile(paths.profile, "utf8"));
    assert.strictEqual(profile.mediaType, "movie");
  });
});

// === §3.4 / §2.3 İzolasyon (TC-8) ===

async function walkRelative(root, base = root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkRelative(full, base)));
    } else {
      out.push(full.slice(base.length + 1));
    }
  }
  return out.sort();
}

describe("R2-A1 — §2.3 Bozuk manifest izolasyonu ve yazım kapsamı", () => {
  it("Manifest bozukken Taste dışı akışlar ve legacy store çalışmaya devam eder", async () => {
    const dataDir = await makeDataDir();
    const mapPath = resolveTasteProfileIdMapPath(dataDir);
    await mkdir(join(dataDir, "taste", "profiles"), { recursive: true });
    const corrupt = "{ \"version\": 1, \"entries\": [ ";
    await writeFile(mapPath, corrupt, "utf8");

    await assert.rejects(
      () => readTasteProfileIdMap(dataDir),
      (err) => err?.code === "profile_id_map_corrupt"
    );
    await assert.rejects(
      () => ensureTasteProfileIdMapEntry("profile-isolation", dataDir),
      (err) => err?.code === "profile_id_map_corrupt"
    );

    // Taste dışı akışlar: legacy store yazımı bu bozukluktan etkilenmez.
    await appendTasteEvent(
      {
        eventId: "scope-isolation-1",
        contentId: "movie:551",
        eventType: "rating_changed",
        payload: { previousValue: null, newValue: 7 },
        recordedAt: AS_OF,
        timeSource: "actual",
        timePrecision: "exact",
      },
      dataDir
    );
    await writeTasteProfile(makeProfile(), dataDir);
    assert.ok(existsSync(resolveTastePaths(dataDir).events), "legacy events yazılmalı");
    assert.strictEqual(await readFile(mapPath, "utf8"), corrupt, "bozuk manifest onarılmamalı");
  });

  it("A1 çağrıları yalnızca verilen dataDir'e yazar (repo data/ dizini değişmez)", async () => {
    const repoData = join(process.cwd(), "data");
    const before = await walkRelative(repoData);

    const dataDir = await makeDataDir();
    const created = await ensureTasteProfileIdMapEntry("profile-scope-only", dataDir);
    assert.ok(created.dir.startsWith(`${TASTE_PROFILE_ID_MAP_SCHEME}-`));

    const scoped = resolveTastePathsForProfile("profile-scope-only", dataDir);
    assert.ok(scoped.paths.profile.startsWith(dataDir), "profil yolu verilen dataDir altında olmalı");
    assert.ok(scoped.root.startsWith(join(dataDir, "taste", "profiles")));
    assert.ok(existsSync(resolveTasteProfileIdMapPath(dataDir)), "manifest geçici dizine yazılmalı");

    const after = await walkRelative(repoData);
    assert.deepStrictEqual(after, before, "repo data/ dizini A1 çağrılarıyla değişmemeli");
  });
});
