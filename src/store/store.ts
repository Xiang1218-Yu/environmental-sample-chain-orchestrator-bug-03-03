import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Aliquot, AnalysisBatch, AuditRecord, CustodyTransfer, EvidencePackage, FileRecord, InstrumentRun, OutboxMessage,
  QualityDecision, ReceivingRecord, ResultRevision, SampleContainer, SamplingRecord, SyncRecord,
} from '../domain/types.js';

class Mutex {
  private tail = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

type Snapshot = {
  sequence: number;
  samples: SamplingRecord[];
  containers: SampleContainer[];
  transfers: CustodyTransfer[];
  receiving: ReceivingRecord[];
  aliquots: Aliquot[];
  batches: AnalysisBatch[];
  runs: InstrumentRun[];
  results: ResultRevision[];
  quality: QualityDecision[];
  evidence: EvidencePackage[];
  syncRecords: SyncRecord[];
  audit: AuditRecord[];
  outbox: OutboxMessage[];
  files: FileRecord[];
};

export class Store {
  readonly samples = new Map<string, SamplingRecord>();
  readonly containers = new Map<string, SampleContainer>();
  readonly transfers = new Map<string, CustodyTransfer>();
  readonly receiving = new Map<string, ReceivingRecord>();
  readonly aliquots = new Map<string, Aliquot>();
  readonly batches = new Map<string, AnalysisBatch>();
  readonly runs = new Map<string, InstrumentRun>();
  readonly results = new Map<string, ResultRevision>();
  readonly quality = new Map<string, QualityDecision>();
  readonly evidence = new Map<string, EvidencePackage>();
  readonly syncRecords = new Map<string, SyncRecord>();
  readonly audit: AuditRecord[] = [];
  readonly outbox: OutboxMessage[] = [];
  readonly files = new Map<string, FileRecord>();
  readonly lock = new Mutex();
  private readonly transactionDepth = new AsyncLocalStorage<number>();
  private sequence = 0;

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(8, '0')}`;
  }

  addAudit(input: Omit<AuditRecord, 'id' | 'createdAt'>): AuditRecord {
    const record = { ...input, id: this.nextId('audit'), createdAt: this.now() };
    this.audit.push(record);
    return record;
  }

  addOutbox(input: Omit<OutboxMessage, 'id' | 'createdAt' | 'status'>): OutboxMessage {
    const message = { ...input, id: this.nextId('outbox'), status: 'PENDING' as const, createdAt: this.now() };
    this.outbox.push(message);
    return message;
  }

  snapshot(): Snapshot {
    return {
      sequence: this.sequence,
      samples: structuredClone([...this.samples.values()]),
      containers: structuredClone([...this.containers.values()]),
      transfers: structuredClone([...this.transfers.values()]),
      receiving: structuredClone([...this.receiving.values()]),
      aliquots: structuredClone([...this.aliquots.values()]),
      batches: structuredClone([...this.batches.values()]),
      runs: structuredClone([...this.runs.values()]),
      results: structuredClone([...this.results.values()]),
      quality: structuredClone([...this.quality.values()]),
      evidence: structuredClone([...this.evidence.values()]),
      syncRecords: structuredClone([...this.syncRecords.values()]),
      audit: structuredClone(this.audit),
      outbox: structuredClone(this.outbox),
      files: structuredClone([...this.files.values()]),
    };
  }

  restore(snapshot: Snapshot): void {
    this.sequence = snapshot.sequence;
    this.replaceMap(this.samples, snapshot.samples);
    this.replaceMap(this.containers, snapshot.containers);
    this.replaceMap(this.transfers, snapshot.transfers);
    this.replaceMap(this.receiving, snapshot.receiving);
    this.replaceMap(this.aliquots, snapshot.aliquots);
    this.replaceMap(this.batches, snapshot.batches);
    this.replaceMap(this.runs, snapshot.runs);
    this.replaceMap(this.results, snapshot.results);
    this.replaceMap(this.quality, snapshot.quality);
    this.replaceMap(this.evidence, snapshot.evidence);
    this.replaceMap(this.syncRecords, snapshot.syncRecords, (value) => value.key);
    this.replaceMap(this.files, snapshot.files, (value) => value.key);
    this.audit.splice(0, this.audit.length, ...snapshot.audit);
    this.outbox.splice(0, this.outbox.length, ...snapshot.outbox);
  }

  async transaction<T>(work: () => Promise<T> | T): Promise<T> {
    if ((this.transactionDepth.getStore() ?? 0) > 0) {
      // Already inside a transaction on this async context (e.g. sync dispatch
      // invoking a transactional service): join it instead of deadlocking on the mutex.
      return work();
    }
    return this.lock.runExclusive(() => this.transactionDepth.run(1, async () => {
      const before = this.snapshot();
      try {
        return await work();
      } catch (error) {
        this.restore(before);
        throw error;
      }
    }));
  }

  private replaceMap<T>(target: Map<string, T>, values: T[], keyOf: (value: T) => string = (value) => (value as T & { id: string }).id): void {
    target.clear();
    for (const value of values) target.set(keyOf(value), value);
  }
}
