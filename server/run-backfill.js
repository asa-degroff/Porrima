import { backfillSupersessions } from './dist/services/memory-extraction.js';

console.log("Running backfill supersession scan...\n");
await backfillSupersessions();
console.log("\nDone.");
