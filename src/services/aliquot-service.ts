import type { Aliquot } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface AliquotRequest {
  tenantId: string;
  projectId: string;
  parentContainerId: string;
  protocolVersion: string;
  createdBy: string;
  operationId: string;
  items: Array<{ barcode: string; volumeMl: number; unit: 'ML' | 'G' | 'L' }>;
}

export class AliquotService {
  constructor(private readonly store: Store) {}

  createMany(input: AliquotRequest): Aliquot[] {
    const prior = [...this.store.aliquots.values()].filter((item) => item.sourceOperationId === input.operationId && item.projectId === input.projectId);
    if (prior.length > 0) return prior;
    const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
    assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
    assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
    const normalized = input.items.map((item) => ({ ...item, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
    this.preflightItems(input, normalized);
    const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
    assertCondition(total > 0 && total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');
    const duplicateBarcode = normalized.find((item, index) => normalized.findIndex((candidate) => candidate.barcode === item.barcode) !== index);
    assertCondition(!duplicateBarcode, 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
    // batch starts. A later collision leaves earlier aliquots already persisted.
    const created: Aliquot[] = [];
    for (const item of normalized) {
      const existing = [...this.store.aliquots.values()].find((aliquot) =>
        aliquot.projectId === input.projectId && aliquot.barcode === item.barcode);
      if (existing) {
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.batch-partially-rejected', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, barcode: item.barcode, createdCount: created.length } });
        throw new Error(`aliquot barcode already exists: ${item.barcode}`);
      }
      const aliquot: Aliquot = {
        id: this.store.nextId('aliquot'),
        tenantId: input.tenantId,
        projectId: input.projectId,
        parentContainerId: input.parentContainerId,
        barcode: item.barcode,
        volumeMl: item.volumeMl,
        unit: 'ML',
        protocolVersion: input.protocolVersion,
        createdBy: input.createdBy,
        createdAt: this.store.now(),
        status: 'AVAILABLE',
        sourceOperationId: input.operationId,
        version: 1,
      };
      this.store.aliquots.set(aliquot.id, aliquot);
      created.push(aliquot);
    }
    container.availableVolumeMl -= total;
    container.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.created', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, count: created.length, volumeMl: total } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'aliquot.created', aggregateId: container.id, payload: JSON.stringify({ operationId: input.operationId, aliquotIds: created.map((item) => item.id), volumeMl: total }) });
    return created;
  }

  allocate(aliquotId: string, batchId: string): Aliquot {
    const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
    assertCondition(aliquot.status === 'AVAILABLE', 'aliquot.not_available', 'aliquot is not available');
    aliquot.status = 'ALLOCATED';
    aliquot.version += 1;
    this.store.addAudit({ tenantId: aliquot.tenantId, projectId: aliquot.projectId, action: 'aliquot.allocated', entity: 'aliquot', entityId: aliquot.id, metadata: { batchId } });
    return aliquot;
  }

  private toMilliliters(value: number, unit: 'ML' | 'G' | 'L'): number {
    assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
    if (unit === 'L') return value * 1000;
    if (unit === 'G') return value;
    return value;
  }

  private preflightItems(input: AliquotRequest, items: Array<{ barcode: string; volumeMl: number; unit: 'ML' | 'G' | 'L' }>): void {
    const seen = new Set<string>();
    for (const item of items) {
      assertCondition(item.barcode.trim().length >= 3, 'aliquot.invalid_barcode', 'barcode is too short');
      assertCondition(!seen.has(item.barcode), 'aliquot.duplicate_barcode', 'barcode repeats in request');
      seen.add(item.barcode);
    }
    const existing = [...this.store.aliquots.values()].filter((item) => item.projectId === input.projectId && seen.has(item.barcode));
    assertCondition(existing.length === 0, 'aliquot.barcode_conflict', 'one or more aliquot barcodes already exist');
    const activeForContainer = [...this.store.aliquots.values()].filter((item) => item.parentContainerId === input.parentContainerId && item.status !== 'DISPOSED');
    assertCondition(activeForContainer.length + items.length <= 500, 'aliquot.too_many_children', 'container aliquot limit exceeded');
    assertCondition(input.protocolVersion.trim().length > 0, 'aliquot.protocol_required', 'protocol version is required');
    assertCondition(input.createdBy.trim().length > 0, 'aliquot.creator_required', 'creator is required');
  }
}
