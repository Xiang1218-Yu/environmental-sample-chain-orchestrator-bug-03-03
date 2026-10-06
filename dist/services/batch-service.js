import { assertCondition, assertFound } from '../domain/errors.js';
export class BatchService {
    store;
    aliquots;
    constructor(store, aliquots) {
        this.store = store;
        this.aliquots = aliquots;
    }
    create(input) {
        assertCondition(input.requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
        const batch = {
            id: this.store.nextId('batch'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            protocolVersion: input.protocolVersion,
            instrumentType: input.instrumentType,
            status: 'DRAFT',
            memberAliquotIds: [],
            requiredControls: structuredClone(input.requiredControls),
            controlResultIds: [],
            createdBy: input.createdBy,
            createdAt: this.store.now(),
            version: 1,
        };
        this.store.batches.set(batch.id, batch);
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.created', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: input.protocolVersion } });
        return batch;
    }
    addAliquot(batchId, aliquotId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
        assertCondition(batch.tenantId === aliquot.tenantId && batch.projectId === aliquot.projectId, 'scope.forbidden', 'batch and aliquot belong to different projects');
        assertCondition(batch.status === 'DRAFT' || batch.status === 'READY', 'batch.members_locked', 'batch members are locked after execution starts');
        if (!batch.memberAliquotIds.includes(aliquotId)) {
            this.aliquots.allocate(aliquotId, batchId);
            batch.memberAliquotIds.push(aliquotId);
            batch.version += 1;
        }
        return batch;
    }
    markReady(batchId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
        batch.status = 'READY';
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
        return batch;
    }
    start(batchId, startedAt) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
        batch.status = 'RUNNING';
        batch.startedAt = startedAt;
        batch.frozenAt = startedAt;
        batch.version += 1;
        for (const aliquotId of batch.memberAliquotIds) {
            const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
            assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
        }
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion } });
        this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
        return batch;
    }
    attachControlResult(batchId, resultId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(!batch.controlResultIds.includes(resultId), 'batch.duplicate_control', 'control result already attached');
        batch.controlResultIds.push(resultId);
        batch.version += 1;
    }
}
