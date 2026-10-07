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

interface NormalizedItem {
  barcode: string;
  volumeMl: number;
}

export class AliquotService {
  constructor(private readonly store: Store) {}

  createMany(input: AliquotRequest): Promise<Aliquot[]> {
    return this.store.transaction(() => this.applyCreateMany(input));
  }

  // A batch is all-or-nothing: every check runs before anything is persisted, so a
  // rejected batch leaves no residue and its operation id stays reusable after the
  // request is fixed. A committed batch is replayed by operation id (scoped to the
  // parent container) without re-deducting volume or duplicating audit records.
  private applyCreateMany(input: AliquotRequest): Aliquot[] {
    assertCondition(input.operationId.trim().length > 0, 'aliquot.operation_required', 'operation id is required');
    const prior = this.findOperationAliquots(input);
    if (prior.length > 0) {
      assertCondition(this.matchesRequest(prior, input), 'aliquot.operation_conflict', 'operation id was already committed with a different payload');
      return prior;
    }
    const foreignOperation = [...this.store.aliquots.values()].find((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.sourceOperationId === input.operationId);
    assertCondition(!foreignOperation, 'aliquot.operation_conflict', 'operation id was already used for a different parent container');
    const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus !== 'ISOLATED', 'aliquot.container_isolated', 'container is isolated and cannot be aliquoted');
    assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
    assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
    assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
    const normalized = input.items.map((item) => ({ barcode: item.barcode, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
    this.preflightItems(input, normalized);
    const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
    assertCondition(total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');
    // All validation is done; the mutation below must not fail partway through.
    const created: Aliquot[] = normalized.map((item) => ({
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
    }));
    for (const aliquot of created) this.store.aliquots.set(aliquot.id, aliquot);
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

  private findOperationAliquots(input: AliquotRequest): Aliquot[] {
    return [...this.store.aliquots.values()].filter((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.parentContainerId === input.parentContainerId && item.sourceOperationId === input.operationId);
  }

  private matchesRequest(prior: Aliquot[], input: AliquotRequest): boolean {
    const normalized = input.items.map((item) => ({ barcode: item.barcode, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
    const keysOf = (items: NormalizedItem[]) => items.map((item) => `${item.barcode} ${item.volumeMl}`).sort().join(';');
    return prior.length === normalized.length
      && keysOf(prior) === keysOf(normalized)
      && prior.every((item) => item.protocolVersion === input.protocolVersion && item.createdBy === input.createdBy);
  }

  private toMilliliters(value: number, unit: 'ML' | 'G' | 'L'): number {
    assertCondition(unit === 'ML' || unit === 'G' || unit === 'L', 'aliquot.invalid_unit', `unsupported aliquot unit: ${String(unit)}`);
    assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
    if (unit === 'L') return value * 1000;
    return value; // ML is already normalized; G is approximated as 1 g ≈ 1 mL for aqueous samples
  }

  private preflightItems(input: AliquotRequest, items: NormalizedItem[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      assertCondition(item.barcode.trim().length >= 3, 'aliquot.invalid_barcode', 'barcode is too short');
      assertCondition(!seen.has(item.barcode), 'aliquot.duplicate_barcode', 'barcode repeats in request');
      seen.add(item.barcode);
    }
    const conflicts = [...this.store.aliquots.values()].filter((item) => item.projectId === input.projectId && seen.has(item.barcode)).map((item) => item.barcode);
    assertCondition(conflicts.length === 0, 'aliquot.barcode_conflict', `aliquot barcodes already exist: ${conflicts.join(', ')}`);
    const activeForContainer = [...this.store.aliquots.values()].filter((item) => item.parentContainerId === input.parentContainerId && item.status !== 'DISPOSED');
    assertCondition(activeForContainer.length + items.length <= 500, 'aliquot.too_many_children', 'container aliquot limit exceeded');
    assertCondition(input.protocolVersion.trim().length > 0, 'aliquot.protocol_required', 'protocol version is required');
    assertCondition(input.createdBy.trim().length > 0, 'aliquot.creator_required', 'creator is required');
  }
}
