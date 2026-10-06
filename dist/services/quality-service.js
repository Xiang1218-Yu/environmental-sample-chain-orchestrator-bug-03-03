import { assertCondition, assertFound } from '../domain/errors.js';
export class QualityService {
    store;
    constructor(store) {
        this.store = store;
    }
    decide(input) {
        const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
        const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
        assertCondition(result.batchId === batch.id && result.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'quality decision is outside the requested project');
        assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');
        const previous = [...this.store.quality.values()].find((decision) => decision.resultId === result.id && decision.projectId === input.projectId && decision.decision === input.decision && decision.ruleVersion === input.ruleVersion);
        if (previous)
            return previous;
        const decision = {
            id: this.store.nextId('quality'),
            tenantId: input.tenantId,
            projectId: input.projectId,
            batchId: input.batchId,
            resultId: input.resultId,
            decision: input.decision,
            reason: input.reason,
            ruleVersion: input.ruleVersion,
            reviewerId: input.reviewerId,
            decidedAt: this.store.now(),
            version: 1,
        };
        this.store.quality.set(decision.id, decision);
        if (input.decision === 'RETEST_REQUIRED') {
            batch.status = 'REJECTED';
            batch.version += 1;
        }
        else if (input.decision === 'REJECTED') {
            batch.status = 'REJECTED';
            batch.version += 1;
        }
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision }) });
        return decision;
    }
    approveBatch(batchId, reviewerId) {
        const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
        assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not ready for approval');
        const currentResults = [...this.store.results.values()].filter((result) => result.batchId === batch.id && result.status === 'CURRENT');
        assertCondition(currentResults.length > 0, 'quality.no_results', 'batch has no current results');
        const controlKinds = new Map();
        for (const result of currentResults) {
            if (result.controlKind)
                controlKinds.set(result.controlKind, (controlKinds.get(result.controlKind) ?? 0) + 1);
        }
        for (const requirement of batch.requiredControls) {
            assertCondition((controlKinds.get(requirement.kind) ?? 0) >= requirement.minimumCount, 'quality.control_missing', `missing control: ${requirement.kind}`);
        }
        for (const result of currentResults) {
            const decisions = [...this.store.quality.values()].filter((decision) => decision.resultId === result.id && decision.decision === 'APPROVED');
            assertCondition(decisions.length > 0, 'quality.result_unapproved', `result ${result.id} has not been approved`);
        }
        batch.status = 'APPROVED';
        batch.approvedAt = this.store.now();
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length } });
        this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId }) });
    }
}
