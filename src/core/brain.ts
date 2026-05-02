import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import { getCachedResponse, setCachedResponse, getOrCreateSession, addMessage } from './cache.js';
import { config } from '../config/settings.js';

// ─── Configurar Gemini ───
const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// ─── Cola de concurrencia y Rate Limiting ───
let processingQueue: Promise<void> = Promise.resolve();
let lastApiCallTime = 0;
const rateLimitMs = 4000; // 4 segundos entre peticiones para no saturar 15 RPM

async function rateLimitDelay() {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < rateLimitMs) {
    const waitTime = rateLimitMs - timeSinceLastCall;
    console.log(`⏳ Esperando ${waitTime}ms por rate limit de Gemini...`);
    await new Promise(r => setTimeout(r, waitTime));
  }
  lastApiCallTime = Date.now();
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    processingQueue = processingQueue.then(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ─── Almacén de vectores en memoria ───
interface StoredDocument {
  text: string;
  embedding: number[];
  metadata: Record<string, string>;
}

let documents: StoredDocument[] = [];

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Cargar documentos indexados ───
async function loadDocuments(): Promise<void> {
  if (documents.length > 0) return;

  const vectorStorePath = path.join(config.paths.vectorStore, 'vector_store.json');
  const docStorePath = path.join(config.paths.vectorStore, 'doc_store.json');

  if (!fs.existsSync(vectorStorePath) || !fs.existsSync(docStorePath)) {
    throw new Error('No se encontraron archivos de índice. Ejecuta `npm run ingest` primero.');
  }

  console.log('📂 Cargando índice vectorial desde disco...');

  const vectorData = JSON.parse(fs.readFileSync(vectorStorePath, 'utf-8'));
  const docData = JSON.parse(fs.readFileSync(docStorePath, 'utf-8'));

  const embeddingDict = vectorData.embeddingDict || {};
  const docs = docData['docstore/data'] || {};

  for (const [nodeId, embeddingArray] of Object.entries(embeddingDict)) {
    const docInfo = docs[nodeId];
    if (!docInfo) continue;

    let text = '';
    let metadata: Record<string, string> = {};

    if (typeof docInfo.__data__ === 'string') {
      try {
        const parsed = JSON.parse(docInfo.__data__);
        text = parsed.text || '';
        metadata = parsed.metadata || {};
      } catch {
        continue;
      }
    } else if (docInfo.__data__) {
      text = docInfo.__data__.text || '';
      metadata = docInfo.__data__.metadata || {};
    }

    if (text) {
      documents.push({
        text,
        embedding: embeddingArray as number[],
        metadata,
      });
    }
  }

  console.log(`✅ ${documents.length} fragmentos cargados en memoria.`);
}

// ─── Generar embedding con Gemini ───
async function getEmbedding(text: string): Promise<number[]> {
  const response = await genai.models.embedContent({
    model: config.gemini.embedModel,
    contents: text,
  });
  return response.embeddings?.[0]?.values || [];
}

// ─── Búsqueda de contexto ───
async function retrieveContext(query: string, topK: number = 5): Promise<string> {
  await loadDocuments();

  const queryEmbedding = await getEmbedding(query);

  if (!queryEmbedding.length) {
    console.warn('⚠️ No se pudo generar embedding para la consulta');
    return '';
  }

  // Si los embeddings almacenados tienen diferente dimensión, re-indexar
  if (documents[0] && documents[0].embedding.length !== queryEmbedding.length) {
    console.log(`⚠️ Dimensiones incompatibles: almacenado=${documents[0].embedding.length}, query=${queryEmbedding.length}`);
    console.log('🔄 Es necesario re-indexar con Gemini embeddings. Ejecuta: npm run ingest');
    // Fallback: devolver los primeros documentos como contexto
    return documents.slice(0, topK).map(d => d.text).join('\n\n---\n\n');
  }

  const scored = documents.map(doc => ({
    doc,
    score: cosineSimilarity(queryEmbedding, doc.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  const topDocs = scored.slice(0, topK);

  console.log('📊 Top resultados:');
  topDocs.forEach((item, i) => {
    const title = item.doc.metadata.title || 'Sin título';
    console.log(`   ${i + 1}. [${(item.score * 100).toFixed(1)}%] ${title}`);
  });

  return topDocs.map(item => item.doc.text).join('\n\n---\n\n');
}

// ─── Función principal del Cerebro RAG ───
export async function askBrain(
  userMessage: string,
  userId: string = 'anonymous',
  channel: string = 'web'
): Promise<string> {
  return enqueue(async () => {
    console.log(`\n💬 [${channel}] Pregunta de ${userId}: "${userMessage}"`);

    // 1. Verificar caché
    const cached = getCachedResponse(userMessage);
    if (cached) {
      console.log('🎯 Cache HIT');
      return cached;
    }

    // 2. Obtener o crear sesión
    const sessionId = getOrCreateSession(userId, channel);
    addMessage(sessionId, 'user', userMessage);

    try {
      // 3. Esperar el rate limit (4 segundos) antes de CUALQUIER llamada a Gemini (incluye embedding)
      await rateLimitDelay();

      // 4. Recuperar contexto relevante (esto llama a Gemini Embeddings)
      console.log('🔍 Buscando contexto relevante...');
      const context = await retrieveContext(userMessage);
      console.log(`📄 Contexto recuperado (${context.length} caracteres)`);

      // 4. Generar respuesta con Gemini Flash
      console.log('🤖 Generando respuesta con Gemini Flash...');
      
      const response = await genai.models.generateContent({
        model: config.gemini.model,
        contents: `CONTEXTO:\n${context}\n\nPREGUNTA: ${userMessage}`,
        config: {
          systemInstruction: config.systemPrompt,
          temperature: 0.3,
          maxOutputTokens: 800,
        },
      });

      const responseText = response.text || 'No se pudo generar una respuesta.';

      console.log(`✅ Respuesta generada (${responseText.length} caracteres)`);

      // 5. Guardar en caché
      setCachedResponse(userMessage, responseText);

      // 6. Guardar mensaje del asistente en historial
      addMessage(sessionId, 'assistant', responseText);

      return responseText;
    } catch (error: any) {
      console.error('❌ Error en el cerebro RAG:', error.message);

      if (error.message?.includes('API_KEY')) {
        return '⚠️ Error con la API Key de Gemini. Verifica que sea válida.';
      }

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        return '⚠️ Se alcanzó el límite de la API de Gemini. Intenta de nuevo en un momento.';
      }

      return '⚠️ Hubo un error procesando tu consulta. Por favor intenta de nuevo en unos momentos.';
    }
  });
}

// Pre-cargar documentos al importar
loadDocuments().catch(e => {
  console.warn('⚠️  No se pudieron pre-cargar los documentos:', e.message);
});
