import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SampleChainApplication } from '../src/app.js';
import { DomainError } from '../src/domain/errors.js';
import type { Aliquot, SampleContainer } from '../src/domain/types.js';
import type { AliquotService, AliquotRequest } from '../src/services/aliquot-service.js';

const TENANT = 'tenant_acme';
const PROJECT = 'project_water';
const NOW = '2026-10-07T09:00:00.000Z';

/**
 * Creates a sealed sample and drives it through handover -> receipt -> lab
 * acceptance, so the container is RELEASED_TO_LAB and aliquotable.
 */
function releaseContainer(app: SampleChainApplication, opts: { totalVolumeMl: number; barcode?: string; tenantId?: string; projectId?: string }): SampleContainer {
  const tenantId = opts.tenantId ?? TENANT;
  const projectId = opts.projectId ?? PROJECT;
  const seq = Math.round(Math.random() * 1e9);
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: NOW,
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: seq,
    containerBarcode: opts.barcode ?? `CNT-${seq}`,
    sealCode: `SEAL-${seq}`,
    totalVolumeMl: opts.totalVolumeMl,
  });
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-SH-01',
    toLocation: 'LAB-SH-A',
    handedOverAt: NOW,
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `handover-${seq}`,
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: NOW, temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_receiver_01', receivedAt: NOW, temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: `receive-${seq}` });
  return sealed.container;
}

/**
 * Volume invariant: a parent's remaining volume plus the non-disposed volume
 * of all its children must equal its original total, and child volumes must be
 * non-negative. Barcodes must be unique within a project.
 */
function assertConsistent(app: SampleChainApplication, container: SampleContainer): void {
  const parent = app.store.containers.get(container.id)!;
  const children = [...app.store.aliquots.values()].filter((item) => item.parentContainerId === parent.id && item.status !== 'DISPOSED');
  const childTotal = children.reduce((sum, item) => sum + item.volumeMl, 0);
  assert.ok(parent.availableVolumeMl >= 0, 'parent available volume must never go negative');
  assert.ok(Math.abs(parent.availableVolumeMl + childTotal - parent.totalVolumeMl) < 1e-6, `volume invariant broken: available(${parent.availableVolumeMl}) + children(${childTotal}) != total(${parent.totalVolumeMl})`);
  const barcodes = new Set<string>();
  for (const child of [...app.store.aliquots.values()].filter((item) => item.projectId === parent.projectId)) {
    assert.ok(!barcodes.has(child.barcode), `duplicate barcode persisted: ${child.barcode}`);
    barcodes.add(child.barcode);
  }
}

function baseRequest(container: SampleContainer, operationId: string, createdBy = 'analyst_01'): Omit<AliquotRequest, 'items'> {
  return { tenantId: TENANT, projectId: PROJECT, parentContainerId: container.id, protocolVersion: 'water-v3', createdBy, operationId };
}

async function expectDomainError<T>(code: string, fn: () => Promise<T>): Promise<void> {
  await assert.rejects(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

test('barcode conflict on item 3 leaves no partial state, and retrying the corrected batch succeeds exactly once', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });
  const service = app.aliquots;

  // A barcode belonging to an unrelated operation already exists.
  await service.createMany({ ...baseRequest(parent, 'op-seed'), items: [{ barcode: 'ALQ-EXISTING', volumeMl: 5, unit: 'ML' }] });

  const request: AliquotRequest = {
    ...baseRequest(parent, 'op-batch-1'),
    items: [
      { barcode: 'ALQ-AAA', volumeMl: 10, unit: 'ML' },
      { barcode: 'ALQ-BBB', volumeMl: 10, unit: 'ML' },
      { barcode: 'ALQ-EXISTING', volumeMl: 10, unit: 'ML' },
    ],
  };
  await expectDomainError('aliquot.barcode_conflict', () => service.createMany(request));

  // Failed attempt left no trace: no aliquots, no parent deduction, no operation record.
  assertConsistent(app, parent);
  assert.equal([...app.store.aliquots.values()].filter((a) => a.sourceOperationId === 'op-batch-1').length, 0);
  assert.equal(app.store.aliquotOperations.has(`${TENANT}|${PROJECT}|op-batch-1`), false);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 95);

  // Correct the batch and retry the whole operation.
  const corrected: AliquotRequest = { ...request, items: [request.items[0]!, request.items[1]!, { barcode: 'ALQ-CCC', volumeMl: 10, unit: 'ML' }] };
  const created = await service.createMany(corrected);
  assert.equal(created.length, 3);
  assertConsistent(app, parent);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 65);

  // Replaying the ORIGINAL failing payload with the same id is a replay conflict;
  // the client must choose a new operation id after correcting items.
  await expectDomainError('aliquot.operation_replay_conflict', () => service.createMany(request));
});

test('insufficient volume is rejected atomically and no children are created', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 15 });
  const service = app.aliquots;

  // Sum exceeds capacity; a 1 L item exercises unit conversion against capacity too.
  await expectDomainError('aliquot.insufficient_volume', () => service.createMany({
    ...baseRequest(parent, 'op-over'),
    items: [{ barcode: 'OV-1', volumeMl: 10, unit: 'ML' }, { barcode: 'OV-2', volumeMl: 1, unit: 'L' }],
  }));
  assert.equal(app.store.aliquots.size, 0);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 15);
  assertConsistent(app, parent);
});

test('unit conversion: litres and grams are normalised to millilitres and semantically equal retries replay', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 500 });
  const service = app.aliquots;

  const created = await service.createMany({
    ...baseRequest(parent, 'op-units'),
    items: [
      { barcode: 'U-LITRE', volumeMl: 0.25, unit: 'L' },
      { barcode: 'U-GRAM', volumeMl: 25, unit: 'G' },
      { barcode: 'U-ML', volumeMl: 25, unit: 'ML' },
    ],
  });
  assert.deepEqual(created.map((a) => [a.volumeMl, a.unit]), [[250, 'L'], [25, 'G'], [25, 'ML']]);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 200);
  assertConsistent(app, parent);

  // An unknown unit (e.g. arriving through a sync payload) is rejected as a domain error.
  const badParent = releaseContainer(app, { totalVolumeMl: 100 });
  const badUnit = { barcode: 'U-BAD', volumeMl: 1, unit: 'OZ' } as unknown as AliquotRequest['items'][number];
  await expectDomainError('aliquot.invalid_unit', () => service.createMany({
    ...baseRequest(badParent, 'op-bad-unit'),
    items: [{ barcode: 'U-ML-2', volumeMl: 1, unit: 'ML' }, badUnit],
  }));
  assertConsistent(app, badParent);

  // Replaying with semantically identical values expressed in mL (fingerprint is unit-normalised).
  const replay = await service.createMany({
    ...baseRequest(parent, 'op-units'),
    items: [
      { barcode: 'U-ML', volumeMl: 25, unit: 'ML' },
      { barcode: 'U-GRAM', volumeMl: 25, unit: 'G' },
      { barcode: 'U-LITRE', volumeMl: 250, unit: 'ML' },
    ],
  });
  assert.deepEqual(replay.map((a) => a.id), created.map((a) => a.id));
  assert.equal(app.store.aliquots.size, 3);
  assert.equal(app.store.outbox.filter((m) => m.topic === 'aliquot.created').length, 1);
});

test('an isolated parent container cannot be aliquoted, but replays of its completed operations still resolve', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });
  const service = app.aliquots;

  const created = await service.createMany({ ...baseRequest(parent, 'op-before-isolation'), items: [{ barcode: 'ISO-1', volumeMl: 10, unit: 'ML' }] });

  // Quarantine the sample while the container record is still released to the lab.
  const sample = app.store.samples.get(parent.sampleId)!;
  sample.status = 'ISOLATED';

  await expectDomainError('aliquot.container_isolated', () => service.createMany({
    ...baseRequest(parent, 'op-after-isolation'),
    items: [{ barcode: 'ISO-2', volumeMl: 10, unit: 'ML' }],
  }));
  assertConsistent(app, parent);
  assert.equal(app.store.aliquots.size, 1);

  // Idempotent replay of the completed op does not re-check mutable container state.
  const replayed = await service.createMany({ ...baseRequest(parent, 'op-before-isolation'), items: [{ barcode: 'ISO-1', volumeMl: 10, unit: 'ML' }] });
  assert.deepEqual(replayed.map((a) => a.id), created.map((a) => a.id));
});

test('two analysts aliquoting concurrently are serialised: over-subscription loses and the winner is replayable', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 30 });
  const service = app.aliquots;

  const analystA: AliquotRequest = {
    ...baseRequest(parent, 'op-concurrent-a', 'analyst_a'),
    items: [{ barcode: 'CON-A1', volumeMl: 20, unit: 'ML' }],
  };
  const analystB: AliquotRequest = {
    ...baseRequest(parent, 'op-concurrent-b', 'analyst_b'),
    items: [{ barcode: 'CON-B1', volumeMl: 20, unit: 'ML' }],
  };

  // Interleave the invocations; only one can fit after the other has deducted.
  const [first, second] = await Promise.allSettled([
    service.createMany(analystA),
    service.createMany(analystB),
  ]);
  assert.equal(first.status === 'fulfilled' || second.status === 'fulfilled', true);
  assert.notEqual(first.status, second.status, 'exactly one analyst must succeed');
  const failed = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;
  assert.ok(failed.reason instanceof DomainError && failed.reason.code === 'aliquot.insufficient_volume');

  assert.equal(app.store.aliquots.size, 1);
  assertConsistent(app, parent);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 10);

  // Both analysts retry; the winner gets the original result, the loser still fails.
  const [retryA, retryB] = await Promise.all([
    service.createMany(analystA).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    ),
    service.createMany(analystB).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    ),
  ]);
  const results = [retryA, retryB];
  const fulfilled = results.filter((r): r is { status: 'fulfilled'; value: Aliquot[] } => r.status === 'fulfilled');
  const rejected = results.filter((r): r is { status: 'rejected'; reason: unknown } => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0]!.reason as DomainError).code === 'aliquot.insufficient_volume');
  assertConsistent(app, parent);
});

test('retry after a client-visible failure returns the existing result with no double deduction', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });
  const service = app.aliquots;

  const request: AliquotRequest = {
    ...baseRequest(parent, 'op-retry'),
    items: [
      { barcode: 'RT-1', volumeMl: 30, unit: 'ML' },
      { barcode: 'RT-2', volumeMl: 10, unit: 'ML' },
    ],
  };

  // A first attempt that fails validation (duplicate barcode in request) must not commit anything.
  await expectDomainError('aliquot.duplicate_barcode', () => service.createMany({
    ...request,
    items: [...request.items, { barcode: 'RT-1', volumeMl: 5, unit: 'ML' }],
  }));
  assert.equal(app.store.aliquots.size, 0);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 100);

  const first = await service.createMany(request);
  const second = await service.createMany(request);
  const third = await service.createMany(request);
  assert.deepEqual(third.map((a) => a.id), first.map((a) => a.id));
  assert.deepEqual(second.map((a) => a.id), first.map((a) => a.id));
  assert.equal(app.store.aliquots.size, 2);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 60);
  assert.equal(app.store.aliquotOperations.size, 1);
  assert.equal(app.store.outbox.filter((m) => m.topic === 'aliquot.created').length, 1);
  const createdAudits = app.store.audit.filter((a) => a.action === 'aliquot.created');
  assert.equal(createdAudits.length, 1);
  assertConsistent(app, parent);
});

test('legacy partial-run orphans are surfaced deterministically instead of being silently duplicated', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });

  // Simulate remnants left by the old non-atomic implementation: two aliquots
  // persisted for an operation whose completion record and deduction never landed.
  const now = app.store.now();
  for (const barcode of ['LEGACY-1', 'LEGACY-2']) {
    const id = app.store.nextId('aliquot');
    app.store.aliquots.set(id, {
      id,
      tenantId: TENANT,
      projectId: PROJECT,
      parentContainerId: parent.id,
      barcode,
      volumeMl: 10,
      unit: 'ML',
      protocolVersion: 'water-v3',
      createdBy: 'analyst_01',
      createdAt: now,
      status: 'AVAILABLE',
      sourceOperationId: 'op-legacy',
      version: 1,
    });
  }

  await expectDomainError('aliquot.operation_recovery_required', () => app.aliquots.createMany({
    ...baseRequest(parent, 'op-legacy'),
    items: [{ barcode: 'LEGACY-1', volumeMl: 10, unit: 'ML' }, { barcode: 'LEGACY-2', volumeMl: 10, unit: 'ML' }],
  }));
});

test('parent container isolation across tenants and projects', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });
  const service = app.aliquots;

  // Same container id referenced from another project/tenant is forbidden.
  await expectDomainError('scope.forbidden', () => service.createMany({
    tenantId: 'tenant_other',
    projectId: 'project_other',
    parentContainerId: parent.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_x',
    operationId: 'op-cross-scope',
    items: [{ barcode: 'CROSS-1', volumeMl: 5, unit: 'ML' }],
  }));

  // The same operation id in a different tenant/project is an independent operation.
  const other = releaseContainer(app, { totalVolumeMl: 100, tenantId: 'tenant_other', projectId: 'project_other' });
  const otherAliquots = await service.createMany({
    tenantId: 'tenant_other',
    projectId: 'project_other',
    parentContainerId: other.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_x',
    operationId: 'op-shared-id',
    items: [{ barcode: 'CROSS-1', volumeMl: 5, unit: 'ML' }],
  });
  const ownAliquots = await service.createMany({
    ...baseRequest(parent, 'op-shared-id'),
    items: [{ barcode: 'OWN-1', volumeMl: 7, unit: 'ML' }],
  });
  assert.equal(otherAliquots.length, 1);
  assert.equal(ownAliquots.length, 1);
  assert.notEqual(otherAliquots[0]!.id, ownAliquots[0]!.id);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 93);
  assert.equal(app.store.containers.get(other.id)!.availableVolumeMl, 95);
  assertConsistent(app, parent);
  assertConsistent(app, other);
});

test('aliquot batch through sync replay is idempotent inside the outer transaction', async () => {
  const app = new SampleChainApplication();
  const parent = releaseContainer(app, { totalVolumeMl: 100 });

  const payload = {
    parentContainerId: parent.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_01',
    items: [{ barcode: 'SYNC-1', volumeMl: 12, unit: 'ML' }],
  };
  const envelope = {
    tenantId: TENANT,
    projectId: PROJECT,
    deviceId: 'device_42',
    clientSequence: 1,
    operationId: 'op-sync-1',
    entityId: parent.id,
    baseVersion: 1,
    type: 'CREATE_ALIQUOT' as const,
    payloadHash: 'hash-a',
    payload,
    occurredAt: NOW,
  };

  const first = await app.sync.apply(envelope);
  const second = await app.sync.apply(envelope);
  assert.equal(first, 'APPLIED');
  assert.equal(second, 'APPLIED');
  assert.equal(app.store.syncRecords.size, 1);
  assert.equal(app.store.aliquots.size, 1);
  assert.equal(app.store.containers.get(parent.id)!.availableVolumeMl, 88);
  assertConsistent(app, parent);
});
