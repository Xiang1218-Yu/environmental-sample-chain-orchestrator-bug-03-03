import { AliquotService } from './services/aliquot-service.js';
import { BatchService } from './services/batch-service.js';
import { CustodyService } from './services/custody-service.js';
import { EvidenceService } from './services/evidence-service.js';
import { QualityService } from './services/quality-service.js';
import { ReceivingService } from './services/receiving-service.js';
import { ResultService } from './services/result-service.js';
import { SamplingService } from './services/sampling-service.js';
import { SyncService } from './services/sync-service.js';
import { Store } from './store/store.js';
export class SampleChainApplication {
    store = new Store();
    sampling = new SamplingService(this.store);
    custody = new CustodyService(this.store);
    receiving = new ReceivingService(this.store);
    aliquots = new AliquotService(this.store);
    batches = new BatchService(this.store, this.aliquots);
    results = new ResultService(this.store);
    quality = new QualityService(this.store);
    evidence = new EvidenceService(this.store);
    sync = new SyncService(this.store, this.sampling, this.custody, this.receiving, this.aliquots);
}
