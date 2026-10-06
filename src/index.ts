import { SampleChainApplication } from './app.js';

const app = new SampleChainApplication();
console.log('Environmental Sample Chain Orchestrator is ready. Use SampleChainApplication from src/app.ts to execute workflows.');
console.log(`Store initialized with ${app.store.samples.size} samples and ${app.store.batches.size} batches.`);
