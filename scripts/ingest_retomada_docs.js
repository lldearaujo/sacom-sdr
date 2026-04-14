'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
// Prioriza a URL externa se disponível (para rodar fora do Docker)
if (process.env.DATABASE_URL_EXTERNAL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_EXTERNAL;
}

const db = require('../server/db');
const rag = require('../server/rag');

const DOCS_DIR = path.join(__dirname, '..', 'SA Comunicação - Retomada', 'docs');

async function ingestDocs() {
  console.log('--- Iniciando Ingestão de Documentos da Retomada ---');
  
  try {
    // 1. Inicializa o banco (garante que as tabelas existem)
    await db.init();
    
    // 2. Lista os arquivos no diretório de documentação
    if (!fs.existsSync(DOCS_DIR)) {
      console.error(`Diretório não encontrado: ${DOCS_DIR}`);
      return;
    }
    
    const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
    console.log(`Encontrados ${files.length} arquivos para processar.`);

    for (const file of files) {
      const filePath = path.join(DOCS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      
      console.log(`\nProcessando: ${file}...`);
      
      // Limpa registros antigos desse arquivo para evitar duplicidade
      await db.deleteKnowledgeByFonte(file);
      
      // Fatia o documento em pedaços de ~1500 caracteres
      const chunks = [];
      const paragraphs = content.split(/\n\s*\n/);
      let currentChunk = '';
      
      for (const p of paragraphs) {
        if (currentChunk.length + p.length > 1500) {
          chunks.push(currentChunk.trim());
          currentChunk = p;
        } else {
          currentChunk += '\n\n' + p;
        }
      }
      if (currentChunk.trim()) chunks.push(currentChunk.trim());

      console.log(`- Gerando embeddings para ${chunks.length} fragmentos...`);
      
      let count = 0;
      for (const chunk of chunks) {
        if (chunk.length < 50) continue; // Pula fragmentos muito pequenos
        
        try {
          const embedding = await rag.getEmbedding(chunk);
          await db.saveKnowledge(`Metodologia: ${file} (Part ${count + 1})`, chunk, embedding, file);
          count++;
          process.stdout.write('.');
        } catch (err) {
          console.error(`\nErro ao processar chunk em ${file}:`, err.message);
        }
      }
      console.log(`\n✅ ${file}: ${count} fragmentos salvos.`);
    }

    console.log('\n--- Ingestão concluída com sucesso! ---');
  } catch (err) {
    console.error('Falha fatal na ingestão:', err);
  } finally {
    process.exit(0);
  }
}

ingestDocs();
