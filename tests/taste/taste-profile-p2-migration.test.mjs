import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  TASTE_PROFILE_ID_MAP_SCHEME,
  encodeProfileIdSafe,
  ensureTasteProfileIdMapEntry,
  readTasteEventsForProfile,
  resolveTasteProfileIdMapPath,
  resolveTasteProfilesRoot,
} from "../../src/server/taste-store.ts";

const CREATED_AT = "2026-11-18T00:00:00.000Z";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ct-p2-migration-"));
}

function p1Dir(rawId) {
  return `p1-b64url-${Buffer.from(rawId, "utf8").toString("base64url")}`;
}

async function writeV1Manifest(dataDir, rawId) {
  const oldDir = p1Dir(rawId);
  const mapPath = resolveTasteProfileIdMapPath(dataDir);
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.writeFile(mapPath, JSON.stringify({
    version: 1,
    scheme: "p1-b64url",
    entries: { [rawId]: { dir: oldDir, createdAt: CREATED_AT } },
    byDir: { [oldDir]: rawId },
  }, null, 2));
  return oldDir;
}

test("p2-hex kimlik normalizasyonu Türkçe ve Latin aksanlarını deterministik dönüştürür", async () => {
  const { validateCanonicalProfileId } = await import("../../src/server/taste-store.ts");
  assert.equal(validateCanonicalProfileId("profile-aaa"), "PROFILE-AAA");
  assert.equal(validateCanonicalProfileId("Profile-Aaa"), "PROFILE-AAA");
  assert.equal(validateCanonicalProfileId("PROFILE-AAA"), "PROFILE-AAA");
  assert.equal(validateCanonicalProfileId("profil-ışık"), "PROFIL-ISIK");
  assert.equal(validateCanonicalProfileId("profil-şölen"), "PROFIL-SOLEN");
  assert.equal(validateCanonicalProfileId("profil-çağrı"), "PROFIL-CAGRI");
  assert.equal(validateCanonicalProfileId("profil-güzel"), "PROFIL-GUZEL");
  assert.equal(validateCanonicalProfileId("profile-café"), "PROFILE-CAFE");
  assert.equal(validateCanonicalProfileId("profile-ñandú"), "PROFILE-NANDU");
});

test("p2-hex dizinleri küçük harfli hex UTF-8 ve benzersizdir", () => {
  const a = encodeProfileIdSafe("profile-aaa");
  const b = encodeProfileIdSafe("profile-aab");
  assert.equal(a, `p2-hex-${Buffer.from("PROFILE-AAA").toString("hex")}`);
  assert.match(a, /^p2-hex-[0-9a-f]+$/);
  assert.notEqual(a, b);
  assert.equal(a, encodeProfileIdSafe("Profile-Aaa"));
});

test("Cyrillic ve diğer desteklenmeyen Unicode alfabeleri reddedilir", async () => {
  const { validateCanonicalProfileId } = await import("../../src/server/taste-store.ts");
  for (const value of ["profile-жук", "profile-العربية", "profile-漢字"]) {
    assert.throws(() => validateCanonicalProfileId(value), (error) => error.code === "invalid_profile_id");
  }
});

test("eski p1-b64url manifesti ve partition verisi doğrulanarak p2-hex'e taşınır", async () => {
  const dataDir = await tempDir();
  try {
    const rawId = "profile-default";
    const oldDir = await writeV1Manifest(dataDir, rawId);
    const profilesRoot = resolveTasteProfilesRoot(dataDir);
    const oldRoot = path.join(profilesRoot, oldDir);
    await fs.mkdir(oldRoot, { recursive: true });
    const payload = JSON.stringify([{
      eventId: "legacy-event-1",
      contentId: "movie:550",
      eventType: "rating_changed",
    }]);
    await fs.writeFile(path.join(oldRoot, "cinetrack-taste-events.json"), payload);

    const events = await readTasteEventsForProfile("PROFILE-DEFAULT", dataDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "legacy-event-1");

    const newDir = encodeProfileIdSafe(rawId);
    const newRoot = path.join(profilesRoot, newDir);
    assert.equal(await fs.readFile(path.join(newRoot, "cinetrack-taste-events.json"), "utf8"), payload);
    await assert.rejects(fs.access(oldRoot));

    const manifest = JSON.parse(await fs.readFile(resolveTasteProfileIdMapPath(dataDir), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.scheme, TASTE_PROFILE_ID_MAP_SCHEME);
    assert.equal(manifest.entries["PROFILE-DEFAULT"].dir, newDir);
    assert.equal(manifest.byDir[newDir], "PROFILE-DEFAULT");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("manifest yokken bulunan tek p1 partition aynı kanonik kimliğe güvenli taşınır", async () => {
  const dataDir = await tempDir();
  try {
    const oldDir = p1Dir("profile-legacy");
    const oldRoot = path.join(resolveTasteProfilesRoot(dataDir), oldDir);
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "keep.json"), '{"safe":true}');
    const result = await ensureTasteProfileIdMapEntry("Profile-Legacy", dataDir);
    assert.equal(result.profileId, "PROFILE-LEGACY");
    assert.equal(result.dir, encodeProfileIdSafe("PROFILE-LEGACY"));
    assert.equal(await fs.readFile(path.join(resolveTasteProfilesRoot(dataDir), result.dir, "keep.json"), "utf8"), '{"safe":true}');
    await assert.rejects(fs.access(oldRoot));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("p1 ve p2 dizinleri çakışırsa kaynak veri korunur ve manifest güncellenmez", async () => {
  const dataDir = await tempDir();
  try {
    const oldDir = await writeV1Manifest(dataDir, "profile-conflict");
    const root = resolveTasteProfilesRoot(dataDir);
    const oldRoot = path.join(root, oldDir);
    const newRoot = path.join(root, encodeProfileIdSafe("profile-conflict"));
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.mkdir(newRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "data.json"), '{"v":1}');
    await fs.writeFile(path.join(newRoot, "data.json"), '{"v":2}');
    const before = await fs.readFile(resolveTasteProfileIdMapPath(dataDir), "utf8");

    await assert.rejects(
      () => ensureTasteProfileIdMapEntry("profile-conflict", dataDir),
      (error) => error.code === "profile_id_map_conflict"
    );
    assert.equal(await fs.readFile(path.join(oldRoot, "data.json"), "utf8"), '{"v":1}');
    assert.equal(await fs.readFile(path.join(newRoot, "data.json"), "utf8"), '{"v":2}');
    assert.equal(await fs.readFile(resolveTasteProfileIdMapPath(dataDir), "utf8"), before);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("başka profilin p1 verisi yeni profile sızmaz", async () => {
  const dataDir = await tempDir();
  try {
    const oldDir = p1Dir("profile-alpha");
    const oldRoot = path.join(resolveTasteProfilesRoot(dataDir), oldDir);
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "cinetrack-taste-events.json"), JSON.stringify([{
      eventId: "alpha-only",
      contentId: "movie:1",
      eventType: "rating_changed",
    }]));
    const betaEvents = await readTasteEventsForProfile("profile-beta", dataDir);
    assert.deepEqual(betaEvents, []);
    assert.equal(await fs.readFile(path.join(oldRoot, "cinetrack-taste-events.json"), "utf8").then((raw) => JSON.parse(raw)[0].eventId), "alpha-only");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
