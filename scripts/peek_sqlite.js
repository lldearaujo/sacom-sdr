const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'SA Comunicação - Retomada', 'sa_comunicacao.db');
const db = new Database(dbPath);

console.log('--- Tabelas no SQLite ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables);

tables.forEach(t => {
  console.log(`\n--- Schema da tabela ${t.name} ---`);
  const info = db.prepare(`PRAGMA table_info(${t.name})`).all();
  console.log(info);
  
  const sample = db.prepare(`SELECT * FROM ${t.name} LIMIT 1`).all();
  console.log(`\nExemplo de dado:`);
  console.log(sample);
});

db.close();
