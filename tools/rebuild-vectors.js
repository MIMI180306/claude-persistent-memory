#!/usr/bin/env node
const memoryDb = require('../lib/memory-db');

async function main() {
  console.log('Rebuilding all embeddings...');
  const vecResult = await memoryDb.rebuildAllEmbeddings();
  console.log('Embeddings done:', vecResult);

  console.log('Rebuilding FTS index...');
  const db = memoryDb.getDb();
  db.exec('DROP TABLE IF EXISTS memories_fts');
  db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, structured_content, summary, tags, keywords)`);
  const rows = db.prepare('SELECT id, content, structured_content, summary, tags, keywords FROM memories').all();
  let count = 0;
  const insert = db.prepare('INSERT INTO memories_fts(rowid, content, structured_content, summary, tags, keywords) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    try {
      insert.run(r.id, memoryDb.tokenize(r.content || ''), memoryDb.tokenize(r.structured_content || ''), memoryDb.tokenize(r.summary || ''), memoryDb.tokenize(r.tags || ''), memoryDb.tokenize(r.keywords || ''));
      count++;
    } catch (e) {}
  }
  console.log(`FTS done: ${count}/${rows.length} indexed`);

  memoryDb.closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
