import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfileId } from "../src/core/profile-id.ts";
import { createProfileContext } from "../src/app/ProfileContext.ts";

test("profil kimliği büyük/küçük harf ve Türkçe Latin karakterlerde tek kimliğe iner", () => {
  assert.equal(normalizeProfileId("profile-aaa"), "PROFILE-AAA");
  assert.equal(normalizeProfileId("Profile-Aaa"), "PROFILE-AAA");
  assert.equal(normalizeProfileId("PROFILE-AAA"), "PROFILE-AAA");
  assert.equal(normalizeProfileId("profil-ışık"), "PROFIL-ISIK");
  assert.equal(normalizeProfileId("profil-şölen"), "PROFIL-SOLEN");
  assert.equal(normalizeProfileId("profil-çağrı"), "PROFIL-CAGRI");
  assert.equal(normalizeProfileId("profil-güzel"), "PROFIL-GUZEL");
});

test("desteklenmeyen alfabeler silinmez, kimlik reddedilir", () => {
  assert.equal(normalizeProfileId("profile-жук"), null);
  assert.equal(normalizeProfileId("profile-العربية"), null);
  assert.equal(normalizeProfileId("profile-漢字"), null);
});

test("ProfileContext tüm giriş biçimlerini aynı aktif profile sabitler", async () => {
  const context = createProfileContext({ initialProfileId: "profile-aaa", initialRevision: 4 });
  assert.equal(context.getCurrent().profileId, "PROFILE-AAA");
  await context.switchProfile("Profile-Aaa", 5);
  assert.equal(context.getCurrent().profileId, "PROFILE-AAA");
  assert.equal(context.getCurrent().revision, 5);
});
