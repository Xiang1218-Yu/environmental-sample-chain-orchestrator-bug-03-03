import type { Aliquot, AliquotOperation } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
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

type NormalizedItem = { barcode: string; volumeMl: number; unit: 'ML' | 'G' | 'L' };

const VOLUME_SCALE = 6;
const MAX_CHILDREN_PER_CONTAINER = 500;

export class AliquotService {
  constructor(private readonly store: Store) {}

  async createMany(input: AliquotRequest): Promise<Aliquot[]> {
    return this.store.transaction(() => this.createManyInTx(input));
  }

  private createManyInTx(input: AliquotRequest): Aliquot[] {
    const operationKey = this.operationKey(input);
    const completed = this.store.aliquotOperations.get(operationKey);
    if (completed) return this.replay(completed, input);
    this.assertNoOrphans(input);
    const normalized = this.normalizeAndValidateItems(input);
    const total = this.roundVolume(normalized.reduce((sum, item) => sum + item.volumeMl, 0));

    const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory');
    assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
    const sample = assertFound(this.store.samples.get(container.sampleId), 'aliquot.sample_not_found', 'parent sample not found');
    assertCondition(sample.status !== 'ISOLATED', 'aliquot.container_isolated', 'container is isolated and cannot be aliquoted');
    assertCondition(input.protocolVersion.trim().length > 0, 'aliquot.protocol_required', 'protocol version is required');
    assertCondition(input.createdBy.trim().length > 0, 'aliquot.creator_required', 'creator is required');

    const activeForContainer = [...this.store.aliquots.values()].filter((item) => item.parentContainerId === input.parentContainerId && item.status !== 'DISPOSED');
    assertCondition(activeForContainer.length + normalized.length <= MAX_CHILDREN_PER_CONTAINER, 'aliquot.too_many_children', 'container aliquot limit exceeded');

    assertCondition(total > 0, 'aliquot.invalid_volume', 'total aliquot volume must be positive');
    assertCondition(total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume');

    // All checks passed. The batch is persisted as one mutation set; throwing
    // before this point rolls back every trace of the attempt via the transaction.
    const created: Aliquot[] = [];
    for (const item of normalized) {
      const aliquot: Aliquot = {
        id: this.store.nextId('aliquot'),
        tenantId: input.tenantId,
        projectId: input.projectId,
        parentContainerId: input.parentContainerId,
        barcode: item.barcode,
        volumeMl: item.volumeMl,
        unit: item.unit,
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

    container.availableVolumeMl = this.roundVolume(container.availableVolumeMl - total);
    container.version += 1;

    const operation: AliquotOperation = {
      id: this.store.nextId('aliquot_op'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      operationId: input.operationId,
      parentContainerId: input.parentContainerId,
      fingerprint: this.fingerprint(input, normalized),
      aliquotIds: created.map((item) => item.id),
      totalVolumeMl: total,
      createdBy: input.createdBy,
      createdAt: this.store.now(),
      status: 'COMPLETED',
      version: 1,
    };
    this.store.aliquotOperations.set(operationKey, operation);

    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.created', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, operationKey, count: created.length, volumeMl: total } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'aliquot.created', aggregateId: container.id, payload: JSON.stringify({ operationId: input.operationId, operationKey, aliquotIds: created.map((item) => item.id), volumeMl: total }) });
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

  private replay(completed: AliquotOperation, input: AliquotRequest): Aliquot[] {
    const normalized = this.normalizeItems(input);
    const fingerprint = this.fingerprint(input, normalized);
    if (fingerprint !== completed.fingerprint || input.parentContainerId !== completed.parentContainerId) {
      throw new DomainError('aliquot.operation_replay_conflict', 'operation id was already completed with a different request; submit corrected items under a new operation id');
    }
    const existing = completed.aliquotIds.map((id) =>
      assertFound(this.store.aliquots.get(id), 'aliquot.replay_state_corrupt', 'recorded aliquots for this operation are missing'));
    return existing;
  }

  private assertNoOrphans(input: AliquotRequest): void {
    const orphans = [...this.store.aliquots.values()].filter(
      (item) => item.tenantId === input.tenantId && item.sourceOperationId === input.operationId && item.projectId === input.projectId,
    );
    if (orphans.length > 0) {
      throw new DomainError(
        'aliquot.operation_recovery_required',
        `operation ${input.operationId} has ${orphans.length} aliquots from a non-atomic partial run; reconcile those records before retrying`,
      );
    }
  }

  private normalizeAndValidateItems(input: AliquotRequest): NormalizedItem[] {
    const normalized = this.normalizeItems(input);
    const seen = new Set(normalized.map((item) => item.barcode));
    const existing = [...this.store.aliquots.values()].filter((item) => item.projectId === input.projectId && seen.has(item.barcode));
    assertCondition(existing.length === 0, 'aliquot.barcode_conflict', 'one or more aliquot barcodes already exist');
    return normalized;
  }

  private normalizeItems(input: AliquotRequest): NormalizedItem[] {
    assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
    const seen = new Set<string>();
    return input.items.map((item) => {
      const barcode = item.barcode.trim();
      assertCondition(barcode.length >= 3, 'aliquot.invalid_barcode', 'barcode is too short');
      assertCondition(!seen.has(barcode), 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
      seen.add(barcode);
      assertCondition(Number.isFinite(item.volumeMl) && item.volumeMl > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
      const unit = item.unit;
      assertCondition(unit === 'ML' || unit === 'G' || unit === 'L', 'aliquot.invalid_unit', `unsupported aliquot unit: ${String(unit)}`);
      return { barcode, volumeMl: this.roundVolume(this.toMilliliters(item.volumeMl, unit)), unit };
    });
  }

  private toMilliliters(value: number, unit: 'ML' | 'G' | 'L'): number {
    if (unit === 'L') return value * 1000;
    // Grams are accepted 1:1 against millilitres on this baseline (no per-matrix density table yet).
    return value;
  }

  private roundVolume(value: number): number {
    const factor = 10 ** VOLUME_SCALE;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  private operationKey(input: AliquotRequest): string {
    return `${input.tenantId}|${input.projectId}|${input.operationId}`;
  }

  private fingerprint(input: AliquotRequest, normalized: NormalizedItem[]): string {
    const canonical = {
      parentContainerId: input.parentContainerId,
      protocolVersion: input.protocolVersion,
      createdBy: input.createdBy,
      items: normalized
        .map((item) => ({ barcode: item.barcode, volumeMl: item.volumeMl }))
        .sort((a, b) => (a.barcode < b.barcode ? -1 : a.barcode > b.barcode ? 1 : 0)),
    };
    return JSON.stringify(canonical);
  }
}
