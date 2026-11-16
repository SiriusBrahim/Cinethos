import test from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../src/core/kernel/index.ts';

/**
 * MIA Faz 1 — modül yaşam döngüsü ve kayıt defteri.
 */

const manifestOf = (id, dependencies = []) => ({
  id,
  displayName: id,
  version: '1.0.0',
  schemaVersion: 1,
  dependencies,
  provides: [id],
});

function trackedModule(id, calls, dependencies = [], extra = {}) {
  const manifest = manifestOf(id, dependencies);
  return {
    manifest,
    create() {
      return {
        manifest,
        api: { id, version: extra.apiVersion ?? 1 },
        internalSecret: 'gizli-uygulama',
        initialize() {
          calls.push(`${id}:initialize`);
          extra.initialize?.();
        },
        start() {
          calls.push(`${id}:start`);
          extra.start?.();
        },
        stop() {
          calls.push(`${id}:stop`);
        },
        healthCheck() {
          return extra.health ?? { healthy: true, metrics: { entries: 1 } };
        },
      };
    },
  };
}

test('Faz 1: modüller bağımlılık sırasına göre başlar, ters sırada durur', async () => {
  const calls = [];
  const kernel = createKernel({ profileId: 'profile-a' });
  kernel.register(trackedModule('gamma', calls, ['beta']));
  kernel.register(trackedModule('alpha', calls));
  kernel.register(trackedModule('beta', calls, ['alpha']));

  const report = await kernel.bootstrap();

  assert.deepEqual(report.started, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(calls, [
    'alpha:initialize',
    'alpha:start',
    'beta:initialize',
    'beta:start',
    'gamma:initialize',
    'gamma:start',
  ]);

  const states = kernel.registry.snapshot().map((entry) => `${entry.moduleId}:${entry.state}`);
  assert.deepEqual(states, ['alpha:running', 'beta:running', 'gamma:running']);

  await kernel.stop();
  assert.deepEqual(calls.slice(6), ['gamma:stop', 'beta:stop', 'alpha:stop']);
});

test('Faz 1: eksik bağımlılık ve döngü ayrı ayrı raporlanır, sağlam modül çalışır', async () => {
  const calls = [];
  const kernel = createKernel();
  kernel.register(trackedModule('orphan', calls, ['ghost']));
  kernel.register(trackedModule('cycle-a', calls, ['cycle-b']));
  kernel.register(trackedModule('cycle-b', calls, ['cycle-a']));
  kernel.register(trackedModule('healthy', calls));

  const report = await kernel.bootstrap();

  assert.deepEqual(report.started, ['healthy']);
  const byId = new Map(report.failed.map((entry) => [entry.moduleId, entry.message]));
  assert.match(byId.get('orphan'), /Eksik bağımlılık: ghost/);
  assert.match(byId.get('cycle-a'), /Döngüsel bağımlılık/);
  assert.match(byId.get('cycle-b'), /Döngüsel bağımlılık/);
  assert.equal(kernel.registry.snapshot().find((e) => e.moduleId === 'orphan').state, 'failed');
});

test('Faz 1: başlatılamayan modül bağımlısını durdurur, uygulamayı düşürmez', async () => {
  const calls = [];
  const kernel = createKernel();
  const failedEvents = [];
  kernel.events.subscribe('module.failed', (event) => failedEvents.push(event.payload));

  kernel.register(
    trackedModule('broken', calls, [], {
      start() {
        throw new Error('başlatma hatası');
      },
    })
  );
  kernel.register(trackedModule('dependent', calls, ['broken']));
  kernel.register(trackedModule('independent', calls));

  const report = await kernel.bootstrap();

  assert.deepEqual(report.started, ['independent']);
  assert.deepEqual(report.skipped, ['dependent']);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].moduleId, 'broken');
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].moduleId, 'broken');

  const states = kernel.registry.snapshot();
  assert.equal(states.find((e) => e.moduleId === 'broken').state, 'failed');
  assert.equal(states.find((e) => e.moduleId === 'dependent').state, 'skipped');
  assert.equal(states.find((e) => e.moduleId === 'independent').state, 'running');
});

test('Faz 1: kayıt defteri hatalı manifestoyu ve tekrarı reddeder', async () => {
  const calls = [];
  const kernel = createKernel();

  assert.throws(
    () => kernel.register({ manifest: manifestOf('Bad Id'), create: () => ({ manifest: manifestOf('Bad Id') }) }),
    (error) => error.code === 'invalid_manifest'
  );
  assert.throws(
    () =>
      kernel.register({
        manifest: { ...manifestOf('versioned'), version: 'sürüm-1' },
        create: () => ({ manifest: { ...manifestOf('versioned'), version: 'sürüm-1' } }),
      }),
    (error) => error.code === 'invalid_manifest'
  );
  assert.throws(
    () => kernel.register(trackedModule('self', calls, ['self'])),
    (error) => error.code === 'invalid_manifest'
  );

  kernel.register(trackedModule('once', calls));
  assert.throws(
    () => kernel.register(trackedModule('once', calls)),
    (error) => error.code === 'duplicate_module'
  );

  await kernel.bootstrap();
  assert.throws(
    () => kernel.register(trackedModule('late', calls)),
    (error) => error.code === 'already_started'
  );
});

test('Faz 1: servis yüzeyi yalnız api, iç uygulama sızmaz', async () => {
  const calls = [];
  const kernel = createKernel();
  kernel.register(trackedModule('alpha', calls));

  assert.throws(() => kernel.registry.getService('alpha'), (error) => error.code === 'not_started');

  await kernel.bootstrap();
  const service = kernel.registry.getService('alpha');
  assert.deepEqual(service, { id: 'alpha', version: 1 });
  assert.equal(service.internalSecret, undefined);

  assert.throws(
    () => kernel.registry.getService('yok-boyle-modul'),
    (error) => error.code === 'unknown_module'
  );
  const missing = kernel.registry.tryGetService('yok-boyle-modul');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'unknown_module');
});

test('Faz 1: sağlık kontrolü modül raporlarını toplar', async () => {
  const calls = [];
  const kernel = createKernel();
  kernel.register(trackedModule('healthy', calls));
  kernel.register(
    trackedModule('degraded', calls, [], {
      health: { healthy: false, detail: 'kuyruk gecikti', metrics: { pending: 3 } },
    })
  );
  kernel.register(trackedModule('broken', calls, [], { start() { throw new Error('yok'); } }));

  await kernel.bootstrap();
  const health = await kernel.healthCheck();

  assert.equal(health.ok, false);
  const byId = new Map(health.modules.map((entry) => [entry.moduleId, entry]));
  assert.equal(byId.get('healthy').healthy, true);
  assert.deepEqual(byId.get('healthy').metrics, { entries: 1 });
  assert.equal(byId.get('degraded').healthy, false);
  assert.equal(byId.get('degraded').detail, 'kuyruk gecikti');
  assert.equal(byId.get('broken').healthy, false);
  assert.match(byId.get('broken').detail, /yok/);
});
