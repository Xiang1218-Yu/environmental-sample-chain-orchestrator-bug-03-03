import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
export class SamplingService {
    store;
    constructor(store) {
        this.store = store;
    }
    createSealedSample(input) {
        const existing = [...this.store.samples.values()].find((sample) => sample.tenantId === input.tenantId && sample.clientDeviceId === input.clientDeviceId && sample.clientSequence === input.clientSequence);
        if (existing) {
            const container = assertFound(existing.containerId ? this.store.containers.get(existing.containerId) : undefined, 'sample.container_missing', 'sample container missing');
            return { sample: existing, container };
        }
        assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
        assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');
        const sampleId = input.sampleId ?? this.store.nextId('sample');
        const containerId = this.store.nextId('container');
        const sample = {
            id: sampleId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            collectorId: input.collectorId,
            protocolVersion: input.protocolVersion,
            medium: input.medium,
            collectedAt: input.collectedAt,
            location: input.location,
            preservation: input.preservation,
            status: 'SEALED',
            clientDeviceId: input.clientDeviceId,
            clientSequence: input.clientSequence,
            containerId,
            version: 1,
        };
        const barcodeConflict = [...this.store.containers.values()].find((item) => item.barcode === input.containerBarcode && item.projectId === input.projectId);
        if (barcodeConflict)
            throw new DomainError('sample.barcode_conflict', 'container barcode already belongs to another sample in this project');
        const container = {
            id: containerId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            sampleId,
            barcode: input.containerBarcode,
            sealCode: input.sealCode,
            sealStatus: 'INTACT',
            custodyStatus: 'SEALED',
            currentHolderId: input.collectorId,
            currentLocation: input.location.siteCode,
            temperatureLog: [{ recordedAt: input.collectedAt, celsius: input.preservation.temperatureCelsius, source: 'HANDHELD' }],
            availableVolumeMl: input.totalVolumeMl,
            totalVolumeMl: input.totalVolumeMl,
            version: 1,
        };
        this.store.samples.set(sample.id, sample);
        this.store.containers.set(container.id, container);
        this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { containerId, protocolVersion: input.protocolVersion } });
        this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId, protocolVersion: input.protocolVersion }) });
        return { sample, container };
    }
    markDisposed(sampleId, actorId) {
        const sample = assertFound(this.store.samples.get(sampleId), 'sample.not_found', 'sample not found');
        const container = assertFound(sample.containerId ? this.store.containers.get(sample.containerId) : undefined, 'sample.container_missing', 'sample container missing');
        assertCondition(sample.status === 'RECEIVED' || sample.status === 'ISOLATED' || sample.status === 'CONSUMED', 'sample.invalid_dispose_state', 'sample cannot be disposed from its current state');
        sample.status = 'DISPOSED';
        sample.version += 1;
        container.custodyStatus = 'ISOLATED';
        container.version += 1;
        this.store.addAudit({ tenantId: sample.tenantId, projectId: sample.projectId, action: 'sample.disposed', entity: 'sample', entityId: sample.id, metadata: { actorId } });
        this.store.addOutbox({ tenantId: sample.tenantId, projectId: sample.projectId, topic: 'sample.disposed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, actorId }) });
    }
}
