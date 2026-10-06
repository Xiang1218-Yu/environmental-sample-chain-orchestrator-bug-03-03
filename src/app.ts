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
  readonly store = new Store();
  readonly sampling = new SamplingService(this.store);
  readonly custody = new CustodyService(this.store);
  readonly receiving = new ReceivingService(this.store);
  readonly aliquots = new AliquotService(this.store);
  readonly batches = new BatchService(this.store, this.aliquots);
  readonly results = new ResultService(this.store);
  readonly quality = new QualityService(this.store);
  readonly evidence = new EvidenceService(this.store);
  readonly sync = new SyncService(this.store, this.sampling, this.custody, this.receiving, this.aliquots);
}
