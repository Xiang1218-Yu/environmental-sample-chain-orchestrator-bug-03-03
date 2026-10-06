import type { ReceivingDecision } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface ReceiveInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  receivedBy: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
  decision: ReceivingDecision;
  reason?: string;
  clientOperationId: string;
}

export class ReceivingService {
  constructor(private readonly store: Store) {}

  receive(input: ReceiveInput) {
    const duplicate = [...this.store.receiving.values()].find((item) => item.clientOperationId === input.clientOperationId && item.projectId === input.projectId);
    if (duplicate) return duplicate;
    const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found');
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving');
    const id = this.store.nextId('receiving');
    const record = {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      decision: input.decision,
      receivedBy: input.receivedBy,
      receivedAt: input.receivedAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.receiving.set(id, record);
    container.custodyStatus = input.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
    container.sealStatus = input.sealStatus;
    container.version += 1;
    const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found');
    sample.status = input.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = input.receivedAt;
    sample.version += 1;
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: input.decision, sealStatus: input.sealStatus, receivingId: id } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: input.decision }) });
    return record;
  }
}
