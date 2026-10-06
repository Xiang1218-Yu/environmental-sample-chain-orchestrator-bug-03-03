import type { EvidencePackage } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export class EvidenceService {
  constructor(private readonly store: Store) {}

  generate(input: { tenantId: string; projectId: string; requestKey: string; includeRejected?: boolean }): EvidencePackage {
    const existing = [...this.store.evidence.values()].find((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.requestKey === input.requestKey);
    if (existing && (existing.status === 'READY' || existing.status === 'FROZEN')) return existing;
    const projectSamples = [...this.store.samples.values()].filter((sample) => sample.tenantId === input.tenantId && sample.projectId === input.projectId);
    const projectContainers = [...this.store.containers.values()].filter((container) => container.tenantId === input.tenantId && container.projectId === input.projectId);
    const projectBatches = [...this.store.batches.values()].filter((batch) => batch.tenantId === input.tenantId && batch.projectId === input.projectId && (input.includeRejected || batch.status === 'APPROVED'));
    const batchIds = new Set(projectBatches.map((batch) => batch.id));
    const results = [...this.store.results.values()].filter((result) => result.tenantId === input.tenantId && result.projectId === input.projectId && batchIds.has(result.batchId) && result.status === 'CURRENT');
    const quality = [...this.store.quality.values()].filter((decision) => decision.tenantId === input.tenantId && decision.projectId === input.projectId && results.some((result) => result.id === decision.resultId));
    const transfers = [...this.store.transfers.values()].filter((transfer) => transfer.tenantId === input.tenantId && transfer.projectId === input.projectId && projectContainers.some((container) => container.id === transfer.containerId));
    assertCondition(projectSamples.length > 0, 'evidence.no_samples', 'project has no samples to export');
    assertCondition(projectBatches.every((batch) => batch.status === 'APPROVED' || input.includeRejected), 'evidence.batch_not_approved', 'all exported batches must be approved');
    const packageId = existing?.id ?? this.store.nextId('evidence');
    const snapshotVersion = this.store.audit.length + this.store.outbox.length + this.store.samples.size + this.store.results.size;
    const sourceIds = { sampleIds: projectSamples.map((sample) => sample.id), containerIds: projectContainers.map((container) => container.id), batchIds: projectBatches.map((batch) => batch.id), resultIds: results.map((result) => result.id), qualityDecisionIds: quality.map((decision) => decision.id) };
    const manifest = JSON.stringify({ sourceIds, transferIds: transfers.map((transfer) => transfer.id), snapshotVersion });
    const manifestHash = stableHash(manifest);
    const fileKey = `evidence/${input.projectId}/${packageId}/${manifestHash}.json`;
    const packageRecord: EvidencePackage = existing ?? {
      id: packageId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      requestKey: input.requestKey,
      status: 'GENERATING',
      snapshotVersion,
      sourceIds,
      fileKeys: [],
      version: 1,
    };
    packageRecord.status = 'READY';
    packageRecord.snapshotVersion = snapshotVersion;
    packageRecord.sourceIds = sourceIds;
    packageRecord.manifestHash = manifestHash;
    packageRecord.fileKeys = [fileKey];
    packageRecord.version += 1;
    packageRecord.frozenAt = this.store.now();
    this.store.evidence.set(packageRecord.id, packageRecord);
    this.store.files.set(fileKey, { key: fileKey, contentHash: manifestHash, createdAt: this.store.now(), status: 'COMMITTED' });
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'evidence.generated', entity: 'evidence', entityId: packageRecord.id, metadata: { snapshotVersion, sourceCount: results.length } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'evidence.ready', aggregateId: packageRecord.id, payload: JSON.stringify({ evidenceId: packageRecord.id, manifestHash, fileKey }) });
    return packageRecord;
  }

  freeze(evidenceId: string): EvidencePackage {
    const packageRecord = assertFound(this.store.evidence.get(evidenceId), 'evidence.not_found', 'evidence package not found');
    if (packageRecord.status === 'FROZEN') return packageRecord;
    if (packageRecord.status !== 'READY') throw new DomainError('evidence.not_ready', 'only ready evidence packages can be frozen');
    packageRecord.status = 'FROZEN';
    packageRecord.version += 1;
    this.store.addAudit({ tenantId: packageRecord.tenantId, projectId: packageRecord.projectId, action: 'evidence.frozen', entity: 'evidence', entityId: packageRecord.id, metadata: { manifestHash: packageRecord.manifestHash ?? null } });
    return packageRecord;
  }
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
