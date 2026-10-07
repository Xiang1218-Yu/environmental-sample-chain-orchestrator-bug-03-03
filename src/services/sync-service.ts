import type { SyncApplyResult, SyncEnvelope } from '../domain/types.js';
import { assertCondition, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { SamplingService } from './sampling-service.js';
import { CustodyService } from './custody-service.js';
import { ReceivingService } from './receiving-service.js';
import { AliquotService } from './aliquot-service.js';

export class SyncService {
  constructor(private readonly store: Store, private readonly sampling: SamplingService, private readonly custody: CustodyService, private readonly receiving: ReceivingService, private readonly aliquots: AliquotService) {}

  async apply(envelope: SyncEnvelope): Promise<SyncApplyResult> {
    return this.store.transaction(async () => {
      const key = `${envelope.tenantId}|${envelope.projectId}|${envelope.deviceId}|${envelope.operationId}`;
      const existing = this.store.syncRecords.get(key);
      if (existing) {
        if (existing.envelope.payloadHash !== envelope.payloadHash) {
          existing.result = 'CONFLICT';
          existing.conflictReason = 'same operation id was submitted with a different payload';
          throw new DomainError('sync.payload_conflict', existing.conflictReason);
        }
        return existing.result;
      }
      const priorSequence = [...this.store.syncRecords.values()].filter((record) => record.envelope.tenantId === envelope.tenantId && record.envelope.projectId === envelope.projectId && record.envelope.deviceId === envelope.deviceId).map((record) => record.envelope.clientSequence).sort((a, b) => b - a)[0];
      if (priorSequence !== undefined && envelope.clientSequence < priorSequence - 1000) {
        this.record(key, envelope, 'STALE', undefined, 'client sequence is outside the accepted replay window');
        return 'STALE';
      }
      const resultReference = await this.dispatch(envelope);
      this.record(key, envelope, 'APPLIED', resultReference);
      return 'APPLIED';
    });
  }

  private async dispatch(envelope: SyncEnvelope): Promise<string> {
    assertCondition(envelope.projectId.length > 0 && envelope.tenantId.length > 0, 'sync.invalid_scope', 'sync envelope must include tenant and project');
    switch (envelope.type) {
      case 'CREATE_SAMPLE': {
        const input = envelope.payload as Parameters<SamplingService['createSealedSample']>[0];
        const created = this.sampling.createSealedSample({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientDeviceId: envelope.deviceId, clientSequence: envelope.clientSequence });
        return created.sample.id;
      }
      case 'CUSTODY_TRANSFER': {
        const input = envelope.payload as Omit<Parameters<CustodyService['handOver']>[0], 'tenantId' | 'projectId' | 'clientOperationId'>;
        return this.custody.handOver({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
      }
      case 'RECEIVE_CONTAINER': {
        const input = envelope.payload as Omit<Parameters<ReceivingService['receive']>[0], 'tenantId' | 'projectId' | 'clientOperationId'>;
        return this.receiving.receive({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
      }
      case 'CREATE_ALIQUOT': {
        const input = envelope.payload as Omit<Parameters<AliquotService['createMany']>[0], 'tenantId' | 'projectId' | 'operationId'>;
        const created = await this.aliquots.createMany({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, operationId: envelope.operationId });
        return created.map((item) => item.id).join(',');
      }
    }
  }

  private record(key: string, envelope: SyncEnvelope, result: SyncApplyResult, resultReference?: string, conflictReason?: string): void {
    this.store.syncRecords.set(key, { key, envelope: structuredClone(envelope), result, ...(resultReference === undefined ? {} : { resultReference }), ...(conflictReason === undefined ? {} : { conflictReason }), appliedAt: this.store.now() });
  }
}
