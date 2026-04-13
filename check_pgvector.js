const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://sacom:s3v3r1n0_o1@72.60.63.29:55896/sacom-srd?sslmode=disable'
});

async function activate() {
  try {
    const version = await pool.query('SELECT version()');
    console.log('=== Versão do PostgreSQL ===');
    console.log(version.rows[0].version);

    const available = await pool.query(
      "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'"
    );
    console.log('\n=== pgvector disponível? ===');
    if (available.rows.length > 0) {
      console.log('SIM:', available.rows[0]);

      await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
      console.log('\n✅ Extensão vector ativada!');

      const installed = await pool.query(
        "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"
      );
      console.log('Versão instalada:', installed.rows[0]);
    } else {
      console.log('❌ pgvector NÃO disponível. Verifique a imagem do container.');
    }
  } catch (e) {
    console.error('Erro:', e.message);
  } finally {
    await pool.end();
  }
}

activate();
