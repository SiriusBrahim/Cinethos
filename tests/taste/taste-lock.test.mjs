/**
 * Faz 5 — R2-A1 Kapsam Kilidi Testleri
 *
 * PR #32 §1 / §2 / §3.4 kabul kriterlerinin kalıcı otomatik test karşılıkları:
 *   canlı kilidin çalınmaması, stale unlink yarışının kapanması,
 *   lease + heartbeat yenileme, sahiplik doğrulamalı bırakma,
 *   bozuk kilidin fail-closed davranışı, kapsam izolasyonu ve FIFO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { dirname, join } from "node:path";

import {
  TASTE_LOCK_DATA_SCOPE,
  TASTE_PROFILE_ID_MAP_SCOPE,
  TASTE_SHARED_METADATA_CACHE_SCOPE,
  acquireTasteLock,
  readTasteLockState,
  resolveTasteLockPath,
  withScopedTasteLock,
} from "../../src/server/taste-store.ts";

const SCOPE = "profile:p1-b64url-cHJvZmlsZS1kZWZhdWx0";

async function makeDataDir() {
  return mkdtemp(join(tmpdir(), "ct-taste-lock-"));
}

function fastTimings(overrides = {}) {
  return {
    acquireTimeoutMs: 250,
    backoffInitialMs: 5,
    backoffMaxMs: 20,
    leaseDurationMs: 5000,
    heartbeatIntervalMs: 1000,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findDeadPid() {
  for (const pid of [3_000_000, 3_000_001, 2_000_000, 4_000_000]) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === "ESRCH") return pid;
    }
  }
  throw new Error("Ölü PID bulunamadı");
}

async function seedLock(lockPath, scope, overrides = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const now = Date.now();
  const record = {
    lockId: randomUUID(),
    scope,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ownerToken: randomUUID(),
    ...overrides,
  };
  await writeFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

async function leftoverLockArtifacts(dataDir) {
  const lockDir = dirname(resolveTasteLockPath(dataDir, SCOPE));
  if (!existsSync(lockDir)) return [];
  return (await readdir(lockDir)).filter((name) => name.endsWith(".tmp"));
}

// === §3.3 / §2 Kapsam edinme ve bırakma ===

describe("R2-A1 — Kapsam kilidi edinme/bırakma", () => {
  it("Kilit edinilir, zorunlu meta alanlarıyla yazılır ve sahibi bırakır", async () => {
    const dataDir = await makeDataDir();
    const handle = await acquireTasteLock({ dataDir, scope: SCOPE, timings: fastTimings() });

    const onDisk = await readTasteLockState(dataDir, SCOPE);
    assert.ok(onDisk, "kilit dosyası okunabilmeli");
    for (const field of [
      "lockId",
      "scope",
      "pid",
      "hostname",
      "createdAt",
      "expiresAt",
      "heartbeatAt",
      "ownerToken",
    ]) {
      assert.ok(onDisk[field], `${field} alanı zorunlu`);
    }
    assert.strictEqual(onDisk.scope, SCOPE);
    assert.strictEqual(onDisk.pid, process.pid);
    assert.strictEqual(onDisk.lockId, handle.record.lockId);
    assert.ok(Date.parse(onDisk.expiresAt) > Date.now(), "lease ileri tarihli olmalı");

    await handle.release();
    assert.strictEqual(await readTasteLockState(dataDir, SCOPE), null, "kilit bırakılmalı");
    assert.deepStrictEqual(await leftoverLockArtifacts(dataDir), []);
  });

  it("Legacy kapsam .taste.lock yolunu korur, kapsamlar ayrı dosyalardadır", () => {
    const legacyPath = resolveTasteLockPath("data", TASTE_LOCK_DATA_SCOPE);
    assert.strictEqual(legacyPath, join("data", "taste", ".taste.lock"));

    const mapPath = resolveTasteLockPath("data", TASTE_PROFILE_ID_MAP_SCOPE);
    assert.ok(mapPath.includes(join("taste", ".locks")), "manifest kilidi .locks altında olmalı");
    assert.notStrictEqual(mapPath, legacyPath);
    assert.notStrictEqual(resolveTasteLockPath("data", SCOPE), mapPath);
  });

  it("Farklı kapsamlar birbirini kilitlemez", async () => {
    const dataDir = await makeDataDir();
    const legacy = await acquireTasteLock({
      dataDir,
      scope: TASTE_LOCK_DATA_SCOPE,
      timings: fastTimings({ acquireTimeoutMs: 300 }),
    });
    const mapLock = await acquireTasteLock({
      dataDir,
      scope: TASTE_PROFILE_ID_MAP_SCOPE,
      timings: fastTimings({ acquireTimeoutMs: 300 }),
    });
    await legacy.release();
    await mapLock.release();
  });

  it("Profil kilidi altından shared-cache kilidi alınmaz (kilit sırası)", async () => {
    const dataDir = await makeDataDir();
    const handle = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 60_000, heartbeatIntervalMs: 30_000 }),
    });

    assert.strictEqual(
      await readTasteLockState(dataDir, TASTE_SHARED_METADATA_CACHE_SCOPE),
      null,
      "profil kilidi shared-cache kilidini örtük almamalı"
    );
    assert.strictEqual(await readTasteLockState(dataDir, TASTE_PROFILE_ID_MAP_SCOPE), null);

    // Sıra: manifest → profil → cache. Profil kilidi tutulurken cache kilidi de alınabilir,
    // ters yönde (cache altında profil) alınmaz.
    const cache = await acquireTasteLock({
      dataDir,
      scope: TASTE_SHARED_METADATA_CACHE_SCOPE,
      timings: fastTimings({ leaseDurationMs: 60_000, heartbeatIntervalMs: 30_000 }),
    });
    await cache.release();
    await handle.release();
  });

  it("Farklı profil kapsamları eşzamanlı tutulabilir (global kilit değil)", async () => {
    const dataDir = await makeDataDir();
    const otherScope = "profile:p1-b64url-cHJvZmlsZS1vdGhlcg";
    const started = Date.now();
    const [a, b] = await Promise.all([
      acquireTasteLock({
        dataDir,
        scope: SCOPE,
        timings: fastTimings({ acquireTimeoutMs: 500, leaseDurationMs: 60_000, heartbeatIntervalMs: 30_000 }),
      }),
      acquireTasteLock({
        dataDir,
        scope: otherScope,
        timings: fastTimings({ acquireTimeoutMs: 500, leaseDurationMs: 60_000, heartbeatIntervalMs: 30_000 }),
      }),
    ]);

    assert.ok(Date.now() - started < 400, "iki farklı kapsam birbirini beklememeli");
    assert.ok(existsSync(resolveTasteLockPath(dataDir, SCOPE)));
    assert.ok(existsSync(resolveTasteLockPath(dataDir, otherScope)));
    await a.release();
    await b.release();
  });

  it("Aynı kapsam süreç içi FIFO ile serileştirilir", async () => {
    const dataDir = await makeDataDir();
    const order = [];
    const run = (label, delayMs) =>
      withScopedTasteLock(
        { dataDir, scope: SCOPE, timings: fastTimings({ acquireTimeoutMs: 2000 }) },
        async () => {
          order.push(`start-${label}`);
          await sleep(delayMs);
          order.push(`end-${label}`);
        }
      );

    await Promise.all([run("a", 60), run("b", 10)]);
    assert.deepStrictEqual(order, ["start-a", "end-a", "start-b", "end-b"]);
    assert.strictEqual(await readTasteLockState(dataDir, SCOPE), null);
  });
});

// === Canlı kilidin çalınmaması ===

describe("R2-A1 — Canlı kilit çalınmaz", () => {
  it("Lease dolmamış kilit PID ölü görünse bile stale sayılmaz", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    const seeded = await seedLock(lockPath, SCOPE, {
      pid: findDeadPid(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const before = await readFile(lockPath, "utf8");

    await assert.rejects(
      () =>
        acquireTasteLock({
          dataDir,
          scope: SCOPE,
          timings: fastTimings({ acquireTimeoutMs: 150, leaseDurationMs: 1000 }),
        }),
      (err) => {
        assert.strictEqual(err?.code, "taste_lock_timeout");
        assert.ok(err.message.includes(SCOPE), "hata kapsamı teşhis edilebilir olmalı");
        assert.ok(err.message.includes(lockPath), "hata dosya yolunu içermeli");
        return true;
      }
    );

    assert.strictEqual(await readFile(lockPath, "utf8"), before, "canlı kilit dosyası değişmemeli");
    assert.strictEqual((await readTasteLockState(dataDir, SCOPE)).lockId, seeded.lockId);
  });

  it("Sahibi canlı olan kilit (lease dolmamış) heartbeat ile korunur", async () => {
    const dataDir = await makeDataDir();
    const holder = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 5000, heartbeatIntervalMs: 1000 }),
    });

    await assert.rejects(
      () =>
        acquireTasteLock({
          dataDir,
          scope: SCOPE,
          timings: fastTimings({ acquireTimeoutMs: 150 }),
        }),
      (err) => err?.code === "taste_lock_timeout"
    );

    const onDisk = await readTasteLockState(dataDir, SCOPE);
    assert.strictEqual(onDisk.lockId, holder.record.lockId, "sahiplik devredilmemeli");
    await holder.release();
  });
});

// === Stale devralma (atomik) ===

describe("R2-A1 — Stale devralma yarışsız", () => {
  it("Lease dolmuş + ölü PID kanıtıyla atomik devralınır, artık dosya bırakmaz", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    const seeded = await seedLock(lockPath, SCOPE, {
      pid: findDeadPid(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const handle = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 5000, heartbeatIntervalMs: 1000 }),
    });

    const onDisk = await readTasteLockState(dataDir, SCOPE);
    assert.notStrictEqual(onDisk.lockId, seeded.lockId, "yeni sahiplik yazılmalı");
    assert.strictEqual(onDisk.lockId, handle.record.lockId);
    assert.deepStrictEqual(await leftoverLockArtifacts(dataDir), [], "karantina artığı kalmamalı");

    await handle.release();
    assert.strictEqual(await readTasteLockState(dataDir, SCOPE), null);
  });

  it("Eşzamanlı stale devralmada tek sahip olur (çifte sahiplik yok)", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    await seedLock(lockPath, SCOPE, {
      pid: findDeadPid(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const timings = fastTimings({
      acquireTimeoutMs: 400,
      leaseDurationMs: 5000,
      heartbeatIntervalMs: 1000,
    });
    const [first, second] = await Promise.allSettled([
      acquireTasteLock({ dataDir, scope: SCOPE, timings }),
      acquireTasteLock({ dataDir, scope: SCOPE, timings }),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1, "yalnızca tek sahip olmalı");
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason?.code, "taste_lock_timeout");

    const winner = fulfilled[0].value;
    const onDisk = await readTasteLockState(dataDir, SCOPE);
    assert.strictEqual(onDisk.lockId, winner.record.lockId, "diskteki sahip kazanan olmalı");
    await winner.release();
  });

  it("Bırakma yalnızca sahibindeyse dosyayı siler", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    const handle = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 60_000, heartbeatIntervalMs: 60_000 }),
    });

    const foreign = await seedLock(lockPath, SCOPE);
    await handle.release();

    assert.ok(existsSync(lockPath), "sahibi olmadığımız kilit silinmemeli");
    assert.strictEqual((await readTasteLockState(dataDir, SCOPE)).lockId, foreign.lockId);
  });
});

// === Lease / heartbeat ===

describe("R2-A1 — Lease ve heartbeat", () => {
  it("Heartbeat lease'i ileri taşır", async () => {
    const dataDir = await makeDataDir();
    const handle = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 600, heartbeatIntervalMs: 100 }),
    });

    const before = (await readTasteLockState(dataDir, SCOPE)).expiresAt;
    await sleep(300);
    const after = (await readTasteLockState(dataDir, SCOPE)).expiresAt;

    assert.ok(Date.parse(after) > Date.parse(before), `lease yenilenmeli (${before} → ${after})`);
    assert.strictEqual(handle.lost, false);
    await handle.release();
  });

  it("Yenileme yalnızca sahibin kaydı üzerinde kabul edilir", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    const handle = await acquireTasteLock({
      dataDir,
      scope: SCOPE,
      timings: fastTimings({ leaseDurationMs: 60_000, heartbeatIntervalMs: 30_000 }),
    });

    const foreign = await seedLock(lockPath, SCOPE);
    await assert.rejects(() => handle.renew(), (err) => err?.code === "taste_lock_lost");
    assert.strictEqual(handle.lost, true, "sahiplik kaybı işaretlenmeli");

    assert.strictEqual((await readTasteLockState(dataDir, SCOPE)).lockId, foreign.lockId);
    await handle.release();
    assert.ok(existsSync(lockPath), "yabancı kayıt bırakma ile silinmemeli");
  });

  it("Sahiplik kaybedilirse kritik bölüm sonucu güvenilir sayılmaz", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    let taskRan = false;

    await assert.rejects(
      () =>
        withScopedTasteLock(
          {
            dataDir,
            scope: SCOPE,
            timings: fastTimings({
              leaseDurationMs: 600,
              heartbeatIntervalMs: 80,
              acquireTimeoutMs: 1000,
            }),
          },
          async () => {
            taskRan = true;
            // Sahiplik dışarıdan devralınmış gibi kaydı değiştir.
            await seedLock(lockPath, SCOPE);
            await sleep(250);
            return "yazıldı";
          }
        ),
      (err) => err?.code === "taste_lock_lost"
    );

    assert.strictEqual(taskRan, true);
    assert.ok(existsSync(lockPath), "yabancı kilit kaydı korunmalı");
  });
});

// === Bozuk kilit ===

describe("R2-A1 — Bozuk kilit fail-closed", () => {
  it("Bozuk JSON stale sayılmaz, silinmez ve teşhis edilebilir hata üretir", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    await mkdir(dirname(lockPath), { recursive: true });
    const corrupt = "pid:123:bozuk";
    await writeFile(lockPath, corrupt, "utf8");

    await assert.rejects(
      () => readTasteLockState(dataDir, SCOPE),
      (err) => err?.code === "taste_lock_corrupt"
    );
    await assert.rejects(
      () => acquireTasteLock({ dataDir, scope: SCOPE, timings: fastTimings() }),
      (err) => err?.code === "taste_lock_corrupt"
    );

    assert.strictEqual(await readFile(lockPath, "utf8"), corrupt, "bozuk kilit silinmemeli");
  });

  it("Boş kilit dosyası (yarım yayın penceresi) stale sayılmaz", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", "utf8");

    await assert.rejects(
      () => acquireTasteLock({ dataDir, scope: SCOPE, timings: fastTimings() }),
      (err) => err?.code === "taste_lock_corrupt"
    );
    assert.strictEqual(await readFile(lockPath, "utf8"), "", "boş kilit silinmemeli");
  });

  it("Eksik alanlı kilit kaydı fail-fast reddedilir", async () => {
    const dataDir = await makeDataDir();
    const lockPath = resolveTasteLockPath(dataDir, SCOPE);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ lockId: "x", pid: 1 }), "utf8");

    await assert.rejects(
      () => acquireTasteLock({ dataDir, scope: SCOPE, timings: fastTimings() }),
      (err) => err?.code === "taste_lock_corrupt"
    );
  });
});

// === Eski (.taste.lock token) biçimiyle geri uyumluluk ===

describe("R2-A1 — Legacy .taste.lock kaydı", () => {
  function legacyLockPath(dataDir) {
    return resolveTasteLockPath(dataDir, TASTE_LOCK_DATA_SCOPE);
  }

  async function seedLegacyToken(dataDir, pid, ageMs) {
    const lockPath = legacyLockPath(dataDir);
    await mkdir(dirname(lockPath), { recursive: true });
    const token = `${pid}:${Date.now() - ageMs}:${randomUUID()}`;
    await writeFile(lockPath, token, "utf8");
    return { lockPath, token };
  }

  it("Ölü PID'li eski token atomik devralınır", async () => {
    const dataDir = await makeDataDir();
    await seedLegacyToken(dataDir, findDeadPid(), 60_000);

    const handle = await acquireTasteLock({
      dataDir,
      scope: TASTE_LOCK_DATA_SCOPE,
      timings: fastTimings({ leaseDurationMs: 5000, heartbeatIntervalMs: 1000 }),
    });

    const onDisk = await readTasteLockState(dataDir, TASTE_LOCK_DATA_SCOPE);
    assert.strictEqual(onDisk.lockId, handle.record.lockId);
    assert.notStrictEqual(onDisk.legacy, true, "yeni kayıt güncel biçimde yazılmalı");

    await handle.release();
    assert.strictEqual(await readTasteLockState(dataDir, TASTE_LOCK_DATA_SCOPE), null);
  });

  it("Canlı PID'li eski token yaş nedeniyle çalınmaz", async () => {
    const dataDir = await makeDataDir();
    // Eski kodun yaş bazlı mantığı bu kaydı "stale" sayardı (yaş > 15s).
    // Canlı ama bu süreç olmayan bir PID kullanılır (üst süreç).
    const livePid = process.ppid;
    const { lockPath, token } = await seedLegacyToken(dataDir, livePid, 3_600_000);

    await assert.rejects(
      () =>
        acquireTasteLock({
          dataDir,
          scope: TASTE_LOCK_DATA_SCOPE,
          timings: fastTimings({ acquireTimeoutMs: 150 }),
        }),
      (err) => err?.code === "taste_lock_timeout"
    );

    assert.strictEqual(await readFile(lockPath, "utf8"), token, "canlı legacy kilit korunmalı");
    const state = await readTasteLockState(dataDir, TASTE_LOCK_DATA_SCOPE);
    assert.strictEqual(state.legacy, true, "legacy kayıt olarak teşhis edilmeli");
    assert.strictEqual(state.pid, livePid);
  });
});
