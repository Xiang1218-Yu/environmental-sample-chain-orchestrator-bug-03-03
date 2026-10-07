import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SampleChainApplication } from '../app.js';
import { DomainError } from '../domain/errors.js';
import type { SyncEnvelope } from '../domain/types.js';
import type { AliquotRequest } from '../services/aliquot-service.js';

const tenantId = 'tenant_lab';
const projectId = 'project_alpha';

type AliquotItem = AliquotRequest['items'][number];

function releaseContainer(app: SampleChainApplication, barcode: string, totalVolumeMl: number, sequence: number, decision: 'ACCEPTED' | 'ISOLATED' = 'ACCEPTED'): string {
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_field_01',
    clientSequence: sequence,
    containerBarcode: barcode,
    sealCode: `SEAL-${barcode}`,
    totalVolumeMl,
  });
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-SH-01',
    toLocation: 'LAB-SH-A',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `handover-${barcode}`,
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_receiver_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision, clientOperationId: `receive-${barcode}` });
  return sealed.container.id;
}

function request(containerId: string, operationId: string, items: AliquotItem[], createdBy = 'analyst_01'): AliquotRequest {
  return { tenantId, projectId, parentContainerId: containerId, protocolVersion: 'water-v3', createdBy, operationId, items };
}

function availableOf(app: SampleChainApplication, containerId: string): number {
  const container = app.store.containers.get(containerId);
  assert.ok(container, `container ${containerId} missing`);
  return container.availableVolumeMl;
}

function aliquotsOf(app: SampleChainApplication, containerId: string) {
  return [...app.store.aliquots.values()].filter((item) => item.parentContainerId === containerId);
}

function auditCount(app: SampleChainApplication, action: string): number {
  return app.store.audit.filter((record) => record.action === action).length;
}

function outboxCount(app: SampleChainApplication, topic: string): number {
  return app.store.outbox.filter((message) => message.topic === topic).length;
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof DomainError)) return false;
    assert.equal(error.code, code);
    return true;
  });
}

describe('aliquot batch creation', () => {
  it('creates the full batch, normalizes units and deducts capacity once', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-001', 500, 1);
    const created = await app.aliquots.createMany(request(containerId, 'op-1', [
      { barcode: 'ALQ-001', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-002', volumeMl: 0.25, unit: 'L' },
      { barcode: 'ALQ-003', volumeMl: 30, unit: 'G' },
    ]));
    assert.equal(created.length, 3);
    assert.deepEqual(created.map((item) => item.volumeMl), [20, 250, 30]);
    assert.ok(created.every((item) => item.unit === 'ML' && item.status === 'AVAILABLE' && item.sourceOperationId === 'op-1'));
    assert.equal(availableOf(app, containerId), 200);
    assert.equal(auditCount(app, 'aliquot.created'), 1);
    assert.equal(outboxCount(app, 'aliquot.created'), 1);
  });

  it('returns the committed batch when the same operation is retried', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-002', 100, 1);
    const items: AliquotItem[] = [
      { barcode: 'ALQ-101', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-102', volumeMl: 20, unit: 'ML' },
    ];
    const first = await app.aliquots.createMany(request(containerId, 'op-retry', items));
    const second = await app.aliquots.createMany(request(containerId, 'op-retry', items));
    const reordered = await app.aliquots.createMany(request(containerId, 'op-retry', [...items].reverse()));
    assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
    assert.deepEqual(reordered.map((item) => item.id), first.map((item) => item.id));
    assert.equal(aliquotsOf(app, containerId).length, 2);
    assert.equal(availableOf(app, containerId), 60);
    assert.equal(auditCount(app, 'aliquot.created'), 1);
    assert.equal(outboxCount(app, 'aliquot.created'), 1);
  });

  it('replays the committed batch even after the container state changed', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-003', 100, 1);
    const first = await app.aliquots.createMany(request(containerId, 'op-state', [{ barcode: 'ALQ-201', volumeMl: 10, unit: 'ML' }]));
    const sample = [...app.store.samples.values()].find((item) => item.containerId === containerId);
    assert.ok(sample);
    app.sampling.markDisposed(sample.id, 'lab_receiver_01');
    assert.equal(app.store.containers.get(containerId)?.custodyStatus, 'ISOLATED');
    const replayed = await app.aliquots.createMany(request(containerId, 'op-state', [{ barcode: 'ALQ-201', volumeMl: 10, unit: 'ML' }]));
    assert.deepEqual(replayed.map((item) => item.id), first.map((item) => item.id));
    assert.equal(aliquotsOf(app, containerId).length, 1);
  });

  it('rejects a retried operation id when the payload changed', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-004', 100, 1);
    await app.aliquots.createMany(request(containerId, 'op-conflict', [{ barcode: 'ALQ-301', volumeMl: 10, unit: 'ML' }]));
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-conflict', [{ barcode: 'ALQ-301', volumeMl: 25, unit: 'ML' }])),
      'aliquot.operation_conflict',
    );
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-conflict', [{ barcode: 'ALQ-301', volumeMl: 10, unit: 'ML' }], 'analyst_02')),
      'aliquot.operation_conflict',
    );
    assert.equal(aliquotsOf(app, containerId).length, 1);
    assert.equal(availableOf(app, containerId), 90);
  });

  it('keeps operations isolated per parent container', async () => {
    const app = new SampleChainApplication();
    const containerA = releaseContainer(app, 'CNT-005A', 100, 1);
    const containerB = releaseContainer(app, 'CNT-005B', 100, 2);
    await app.aliquots.createMany(request(containerA, 'op-shared', [{ barcode: 'ALQ-401', volumeMl: 10, unit: 'ML' }]));
    await expectDomainError(
      app.aliquots.createMany(request(containerB, 'op-shared', [{ barcode: 'ALQ-402', volumeMl: 10, unit: 'ML' }])),
      'aliquot.operation_conflict',
    );
    assert.equal(aliquotsOf(app, containerA).length, 1);
    assert.equal(aliquotsOf(app, containerB).length, 0);
    assert.equal(availableOf(app, containerB), 100);
  });

  it('fails atomically when a barcode collides with an existing aliquot', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-006', 100, 1);
    await app.aliquots.createMany(request(containerId, 'op-1', [
      { barcode: 'ALQ-501', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-502', volumeMl: 20, unit: 'ML' },
    ]));
    // The third item collides with an existing barcode: the whole batch must be
    // rejected without persisting the first two items or touching the volume.
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-2', [
        { barcode: 'ALQ-601', volumeMl: 10, unit: 'ML' },
        { barcode: 'ALQ-602', volumeMl: 10, unit: 'ML' },
        { barcode: 'ALQ-501', volumeMl: 10, unit: 'ML' },
      ])),
      'aliquot.barcode_conflict',
    );
    assert.equal(aliquotsOf(app, containerId).length, 2);
    assert.equal(availableOf(app, containerId), 60);
    assert.equal(auditCount(app, 'aliquot.created'), 1);
    assert.equal(auditCount(app, 'aliquot.batch-partially-rejected'), 0);
    assert.equal(outboxCount(app, 'aliquot.created'), 1);
  });

  it('rejects duplicate barcodes inside one request without side effects', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-007', 100, 1);
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-dup', [
        { barcode: 'ALQ-701', volumeMl: 10, unit: 'ML' },
        { barcode: 'ALQ-701', volumeMl: 15, unit: 'ML' },
      ])),
      'aliquot.duplicate_barcode',
    );
    assert.equal(aliquotsOf(app, containerId).length, 0);
    assert.equal(availableOf(app, containerId), 100);
  });

  it('rejects requests that exceed the available volume', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-008', 100, 1);
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-over', [
        { barcode: 'ALQ-801', volumeMl: 60, unit: 'ML' },
        { barcode: 'ALQ-802', volumeMl: 50, unit: 'ML' },
      ])),
      'aliquot.insufficient_volume',
    );
    assert.equal(aliquotsOf(app, containerId).length, 0);
    assert.equal(availableOf(app, containerId), 100);
    const exact = await app.aliquots.createMany(request(containerId, 'op-exact', [{ barcode: 'ALQ-803', volumeMl: 100, unit: 'ML' }]));
    assert.equal(exact.length, 1);
    assert.equal(availableOf(app, containerId), 0);
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-one-more', [{ barcode: 'ALQ-804', volumeMl: 1, unit: 'ML' }])),
      'aliquot.insufficient_volume',
    );
  });

  it('rejects illegal units and non-positive volumes without side effects', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-009', 100, 1);
    const badUnit = (unit: string) => [{ barcode: `ALQ-9${unit.length}${unit.charCodeAt(0)}`, volumeMl: 10, unit }] as AliquotItem[];
    await expectDomainError(app.aliquots.createMany(request(containerId, 'op-unit-1', badUnit('mL'))), 'aliquot.invalid_unit');
    await expectDomainError(app.aliquots.createMany(request(containerId, 'op-unit-2', badUnit('KG'))), 'aliquot.invalid_unit');
    await expectDomainError(app.aliquots.createMany(request(containerId, 'op-vol-1', [{ barcode: 'ALQ-901', volumeMl: 0, unit: 'ML' }])), 'aliquot.invalid_volume');
    await expectDomainError(app.aliquots.createMany(request(containerId, 'op-vol-2', [{ barcode: 'ALQ-902', volumeMl: -5, unit: 'ML' }])), 'aliquot.invalid_volume');
    await expectDomainError(app.aliquots.createMany(request(containerId, 'op-vol-3', [{ barcode: 'ALQ-903', volumeMl: Number.NaN, unit: 'ML' }])), 'aliquot.invalid_volume');
    assert.equal(aliquotsOf(app, containerId).length, 0);
    assert.equal(availableOf(app, containerId), 100);
    assert.equal(auditCount(app, 'aliquot.created'), 0);
  });

  it('refuses to aliquot an isolated parent container', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-010', 100, 1, 'ISOLATED');
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-isolated', [{ barcode: 'ALQ-1001', volumeMl: 10, unit: 'ML' }])),
      'aliquot.container_isolated',
    );
    assert.equal(aliquotsOf(app, containerId).length, 0);
    assert.equal(availableOf(app, containerId), 100);
  });

  it('refuses containers that are not released to the lab or are out of scope', async () => {
    const app = new SampleChainApplication();
    const sealed = app.sampling.createSealedSample({
      tenantId,
      projectId,
      collectorId: 'collector_01',
      protocolVersion: 'water-v3',
      medium: 'WATER',
      collectedAt: '2026-10-06T08:00:00.000Z',
      location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
      preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
      clientDeviceId: 'device_field_01',
      clientSequence: 1,
      containerBarcode: 'CNT-011',
      sealCode: 'SEAL-011',
      totalVolumeMl: 100,
    });
    await expectDomainError(
      app.aliquots.createMany(request(sealed.container.id, 'op-sealed', [{ barcode: 'ALQ-1101', volumeMl: 10, unit: 'ML' }])),
      'aliquot.container_not_released',
    );
    const containerId = releaseContainer(app, 'CNT-012', 100, 2);
    await expectDomainError(
      app.aliquots.createMany({ ...request(containerId, 'op-scope', [{ barcode: 'ALQ-1102', volumeMl: 10, unit: 'ML' }]), projectId: 'project_other' }),
      'scope.forbidden',
    );
    assert.equal(aliquotsOf(app, containerId).length, 0);
  });

  it('serializes two analysts aliquoting the same container concurrently', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-013', 100, 1);
    const batchOf = (prefix: string, volumeMl: number): AliquotItem[] => [1, 2, 3].map((index) => ({ barcode: `${prefix}-${index}`, volumeMl: volumeMl / 3, unit: 'ML' }));
    const [first, second] = await Promise.allSettled([
      app.aliquots.createMany(request(containerId, 'op-analyst-a', batchOf('ALQ-A', 60), 'analyst_01')),
      app.aliquots.createMany(request(containerId, 'op-analyst-b', batchOf('ALQ-B', 60), 'analyst_02')),
    ]);
    const settled = [first, second];
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = settled.find((item) => item.status === 'rejected');
    assert.ok(rejected, 'expected one analyst batch to be rejected');
    if (rejected.status !== 'rejected') assert.fail('expected one analyst batch to be rejected');
    assert.ok(rejected.reason instanceof DomainError);
    assert.equal(rejected.reason.code, 'aliquot.insufficient_volume');
    assert.equal(aliquotsOf(app, containerId).length, 3);
    assert.equal(availableOf(app, containerId), 40);
    assert.equal(auditCount(app, 'aliquot.created'), 1);

    // When both batches fit, both analysts succeed and the deductions add up.
    const roomier = releaseContainer(app, 'CNT-014', 100, 2);
    const [fitA, fitB] = await Promise.all([
      app.aliquots.createMany(request(roomier, 'op-fit-a', batchOf('ALQ-FA', 30), 'analyst_01')),
      app.aliquots.createMany(request(roomier, 'op-fit-b', batchOf('ALQ-FB', 40), 'analyst_02')),
    ]);
    assert.equal(fitA.length + fitB.length, 6);
    assert.equal(aliquotsOf(app, roomier).length, 6);
    assert.equal(availableOf(app, roomier), 30);
  });

  it('deducts once when the same operation is submitted concurrently', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-015', 100, 1);
    const req = request(containerId, 'op-race', [
      { barcode: 'ALQ-1501', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-1502', volumeMl: 20, unit: 'ML' },
    ]);
    const [first, second] = await Promise.all([app.aliquots.createMany(req), app.aliquots.createMany(req)]);
    assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
    assert.equal(aliquotsOf(app, containerId).length, 2);
    assert.equal(availableOf(app, containerId), 60);
    assert.equal(auditCount(app, 'aliquot.created'), 1);
    assert.equal(outboxCount(app, 'aliquot.created'), 1);
  });

  it('recovers cleanly: fix the failed batch and retry with the same operation id', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-016', 200, 1);
    await app.aliquots.createMany(request(containerId, 'op-1', [{ barcode: 'ALQ-1601', volumeMl: 20, unit: 'ML' }]));
    // First attempt fails on the third item (barcode conflict); nothing is persisted.
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-2', [
        { barcode: 'ALQ-1602', volumeMl: 30, unit: 'ML' },
        { barcode: 'ALQ-1603', volumeMl: 30, unit: 'ML' },
        { barcode: 'ALQ-1601', volumeMl: 30, unit: 'ML' },
      ])),
      'aliquot.barcode_conflict',
    );
    assert.equal(aliquotsOf(app, containerId).length, 1);
    assert.equal(availableOf(app, containerId), 180);
    // The client fixes the payload and retries the whole batch with the same operation id.
    const retried = await app.aliquots.createMany(request(containerId, 'op-2', [
      { barcode: 'ALQ-1602', volumeMl: 30, unit: 'ML' },
      { barcode: 'ALQ-1603', volumeMl: 30, unit: 'ML' },
      { barcode: 'ALQ-1604', volumeMl: 30, unit: 'ML' },
    ]));
    assert.equal(retried.length, 3);
    assert.equal(aliquotsOf(app, containerId).length, 4);
    assert.equal(availableOf(app, containerId), 90);
    assert.equal(auditCount(app, 'aliquot.created'), 2);
    // A later replay of the committed operation returns the same result.
    const replayed = await app.aliquots.createMany(request(containerId, 'op-2', [
      { barcode: 'ALQ-1602', volumeMl: 30, unit: 'ML' },
      { barcode: 'ALQ-1603', volumeMl: 30, unit: 'ML' },
      { barcode: 'ALQ-1604', volumeMl: 30, unit: 'ML' },
    ]));
    assert.deepEqual(replayed.map((item) => item.id), retried.map((item) => item.id));
    assert.equal(availableOf(app, containerId), 90);
    assert.equal(auditCount(app, 'aliquot.created'), 2);
  });

  it('keeps volume, aliquot totals and operation records consistent across failures and retries', async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-017', 500, 1);
    await app.aliquots.createMany(request(containerId, 'op-a', [
      { barcode: 'ALQ-1701', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-1702', volumeMl: 0.25, unit: 'L' },
    ]));
    await app.aliquots.createMany(request(containerId, 'op-a', [
      { barcode: 'ALQ-1701', volumeMl: 20, unit: 'ML' },
      { barcode: 'ALQ-1702', volumeMl: 0.25, unit: 'L' },
    ]));
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-b', [
        { barcode: 'ALQ-1703', volumeMl: 100, unit: 'ML' },
        { barcode: 'ALQ-1701', volumeMl: 5, unit: 'ML' },
      ])),
      'aliquot.barcode_conflict',
    );
    await app.aliquots.createMany(request(containerId, 'op-b', [
      { barcode: 'ALQ-1703', volumeMl: 100, unit: 'ML' },
      { barcode: 'ALQ-1704', volumeMl: 50, unit: 'ML' },
    ]));
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-c', [{ barcode: 'ALQ-1705', volumeMl: 1000, unit: 'ML' }])),
      'aliquot.insufficient_volume',
    );
    await app.aliquots.createMany(request(containerId, 'op-c', [{ barcode: 'ALQ-1705', volumeMl: 80, unit: 'ML' }]));
    await expectDomainError(
      app.aliquots.createMany(request(containerId, 'op-d', [{ barcode: 'ALQ-1706', volumeMl: 1, unit: 'ML' }])),
      'aliquot.insufficient_volume',
    );
    const aliquots = aliquotsOf(app, containerId);
    const totalAliquotVolume = aliquots.reduce((sum, item) => sum + item.volumeMl, 0);
    assert.equal(aliquots.length, 5);
    assert.equal(totalAliquotVolume, 500);
    assert.equal(availableOf(app, containerId), 0);
    assert.equal(availableOf(app, containerId) + totalAliquotVolume, 500);
    assert.equal(auditCount(app, 'aliquot.created'), 3);
    assert.equal(outboxCount(app, 'aliquot.created'), 3);
    assert.equal(auditCount(app, 'aliquot.batch-partially-rejected'), 0);
    // Every committed operation record matches the aliquots that carry its operation id.
    const createdAudits = app.store.audit.filter((record) => record.action === 'aliquot.created');
    for (const audit of createdAudits) {
      const operationId = audit.metadata['operationId'];
      const members = aliquots.filter((item) => item.sourceOperationId === operationId);
      assert.equal(members.length, audit.metadata['count']);
      assert.equal(members.reduce((sum, item) => sum + item.volumeMl, 0), audit.metadata['volumeMl']);
    }
  });
});

describe('sync CREATE_ALIQUOT integration', () => {
  function envelope(containerId: string, operationId: string, payloadHash: string, items: AliquotItem[]): SyncEnvelope {
    return {
      tenantId,
      projectId,
      deviceId: 'device_lab_01',
      clientSequence: 1,
      operationId,
      entityId: containerId,
      baseVersion: 0,
      type: 'CREATE_ALIQUOT',
      payloadHash,
      payload: { parentContainerId: containerId, protocolVersion: 'water-v3', createdBy: 'analyst_01', items },
      occurredAt: '2026-10-06T10:30:00.000Z',
    };
  }

  it('applies a synced batch once and replays it idempotently', { timeout: 5000 }, async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-101', 100, 1);
    const first = await app.sync.apply(envelope(containerId, 'sync-op-1', 'hash-1', [{ barcode: 'ALQ-9101', volumeMl: 25, unit: 'ML' }]));
    const second = await app.sync.apply(envelope(containerId, 'sync-op-1', 'hash-1', [{ barcode: 'ALQ-9101', volumeMl: 25, unit: 'ML' }]));
    assert.equal(first, 'APPLIED');
    assert.equal(second, 'APPLIED');
    assert.equal(aliquotsOf(app, containerId).length, 1);
    assert.equal(availableOf(app, containerId), 75);
    assert.equal(auditCount(app, 'aliquot.created'), 1);
  });

  it('flags a conflicting payload for the same sync operation', { timeout: 5000 }, async () => {
    const app = new SampleChainApplication();
    const containerId = releaseContainer(app, 'CNT-102', 100, 1);
    const applied = await app.sync.apply(envelope(containerId, 'sync-op-2', 'hash-1', [{ barcode: 'ALQ-9201', volumeMl: 25, unit: 'ML' }]));
    assert.equal(applied, 'APPLIED');
    await expectDomainError(
      app.sync.apply(envelope(containerId, 'sync-op-2', 'hash-2', [{ barcode: 'ALQ-9202', volumeMl: 25, unit: 'ML' }])),
      'sync.payload_conflict',
    );
    assert.equal(aliquotsOf(app, containerId).length, 1);
    assert.equal(availableOf(app, containerId), 75);
  });
});
