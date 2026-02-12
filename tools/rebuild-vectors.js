#!/usr/bin/env node
const memoryDb = require('../lib/memory-db');

async function main() {
  console.log('Rebuilding all embeddings...');
  const result = await memoryDb.rebuildAllEmbeddings();
  console.log('Done:', result);
  memoryDb.closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
