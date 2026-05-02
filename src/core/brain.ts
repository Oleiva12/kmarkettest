import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import {
  getCachedResponse, setCachedResponse, getOrCreateSession, addMessage,
  logProductQuery, logCategoryQuery,
  getOnboardingState, setOnboardingState, createLead, getLeadBySessionId
} from './cache.js';
import { config } from '../config/settings.js';

// ─── Pool de API Keys con rotación ───
const apiKeys = config.gemini.apiKey.split(',').map(k => k.trim()).filter(Boolean);
const genaiPool = apiKeys.map(key => new GoogleGenAI({ apiKey: key }));
let currentKeyIndex = 0;

function getNextClient(): GoogleGenAI {
  const client = genaiPool[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % genaiPool.length;
  return client;
}

console.log(`🔑 ${apiKeys.length} API key(s) configuradas — límite efectivo: ~${apiKeys.length * 15} RPM`);

// ─── Cola de concurrencia y Rate Limiting ───
let processingQueue: Promise<void> = Promise.resolve();
let lastApiCallTime = 0;
// Con N keys, podemos reducir el delay proporcionalmente
const rateLimitMs = Math.max(1000, Math.floor(4000 / apiKeys.length));

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
  const client = getNextClient();
  const response = await client.models.embedContent({
    model: config.gemini.embedModel,
    contents: text,
  });
  return response.embeddings?.[0]?.values || [];
}

// ─── Búsqueda de contexto ───
interface RetrievalResult {
  context: string;
  products: string[];
  categories: string[];
}

async function retrieveContext(query: string, topK: number = 5): Promise<RetrievalResult> {
  await loadDocuments();

  const queryEmbedding = await getEmbedding(query);

  if (!queryEmbedding.length) {
    console.warn('⚠️ No se pudo generar embedding para la consulta');
    return { context: '', products: [], categories: [] };
  }

  // Si los embeddings almacenados tienen diferente dimensión, re-indexar
  if (documents[0] && documents[0].embedding.length !== queryEmbedding.length) {
    console.log(`⚠️ Dimensiones incompatibles: almacenado=${documents[0].embedding.length}, query=${queryEmbedding.length}`);
    console.log('🔄 Es necesario re-indexar con Gemini embeddings. Ejecuta: npm run ingest');
    return {
      context: documents.slice(0, topK).map(d => d.text).join('\n\n---\n\n'),
      products: [],
      categories: [],
    };
  }

  const scored = documents.map(doc => ({
    doc,
    score: cosineSimilarity(queryEmbedding, doc.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  const topDocs = scored.slice(0, topK);

  console.log('📊 Top resultados:');
  const products: string[] = [];
  const categories: string[] = [];

  topDocs.forEach((item, i) => {
    const title = item.doc.metadata.title || 'Sin título';
    const category = item.doc.metadata.category || '';
    console.log(`   ${i + 1}. [${(item.score * 100).toFixed(1)}%] ${title}`);

    // Solo trackear si la relevancia es > 55%
    if (item.score > 0.55) {
      if (title && !products.includes(title)) products.push(title);
      if (category && !categories.includes(category)) categories.push(category);
    }
  });

  return {
    context: topDocs.map(item => item.doc.text).join('\n\n---\n\n'),
    products,
    categories,
  };
}

// ─── Onboarding: procesar respuesta del usuario ───
export interface OnboardingResult {
  onboardingMessage: string | null;
  shouldContinue: boolean; // si true, además hacer RAG
  skipPhoneButton?: boolean;
}

export function processOnboarding(sessionId: string, userMessage: string, channel: string): OnboardingResult {
  let state = getOnboardingState(sessionId);

  // Si ya completó onboarding o no ha iniciado, no intervenir
  if (!state || state.completed === 1) {
    return { onboardingMessage: null, shouldContinue: true };
  }

  const msg = userMessage.trim();

  switch (state.step) {
    case 'ask_name':
      setOnboardingState(sessionId, { first_name: msg, step: 'ask_lastname' });
      return {
        onboardingMessage: `¡Gracias, ${msg}! 😊 ¿Y cuál es tu apellido?`,
        shouldContinue: false,
      };

    case 'ask_lastname':
      setOnboardingState(sessionId, { last_name: msg, step: 'ask_email' });
      return {
        onboardingMessage: `Perfecto, ${state.first_name} ${msg}. ¿Me compartes tu correo electrónico para enviarte cotizaciones? 📧`,
        shouldContinue: false,
      };

    case 'ask_email': {
      // Validar email básico
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(msg)) {
        return {
          onboardingMessage: `Hmm, ese no parece ser un correo válido. ¿Podrías verificar? (ejemplo: tu@email.com)`,
          shouldContinue: false,
        };
      }
      setOnboardingState(sessionId, { email: msg, step: 'ask_phone' });
      return {
        onboardingMessage: `¡Excelente! Por último, ¿tu número de teléfono? (Esto es opcional)`,
        shouldContinue: false,
        skipPhoneButton: true,
      };
    }

    case 'ask_phone': {
      const isSkip = msg.toLowerCase() === 'saltar' || msg.toLowerCase() === 'skip' || msg === '⏭️';
      const phone = isSkip ? '' : msg;

      setOnboardingState(sessionId, { phone, step: 'done', completed: 1 });

      // Crear el lead
      const finalState = getOnboardingState(sessionId)!;
      createLead({
        first_name: finalState.first_name,
        last_name: finalState.last_name,
        email: finalState.email,
        phone: phone,
        channel,
        session_id: sessionId,
      });

      console.log(`🎯 Nuevo lead creado: ${finalState.first_name} ${finalState.last_name} (${finalState.email})`);

      return {
        onboardingMessage: `¡Listo, ${finalState.first_name}! 🎉 Ya tengo tus datos. Ahora puedo darte una atención más personalizada. ¿En qué te puedo ayudar?`,
        shouldContinue: false,
      };
    }

    default:
      return { onboardingMessage: null, shouldContinue: true };
  }
}

// Iniciar el onboarding para una sesión nueva
export function startOnboarding(sessionId: string): string {
  const existing = getOnboardingState(sessionId);
  if (existing) {
    if (existing.completed === 1) return ''; // Ya completado
    return ''; // Ya en proceso
  }

  setOnboardingState(sessionId, { step: 'ask_name' });
  return '\n\n---\n📋 Para darte una mejor atención, ¿me compartes tu nombre?';
}

// ─── Función principal del Cerebro RAG ───
export async function askBrain(
  userMessage: string,
  userId: string = 'anonymous',
  channel: string = 'web'
): Promise<{ response: string; onboarding?: OnboardingResult }> {
  return enqueue(async () => {
    console.log(`\n💬 [${channel}] Pregunta de ${userId}: "${userMessage}"`);

    // 1. Verificar si estamos en onboarding
    const onboardingResult = processOnboarding(userId, userMessage, channel);
    if (onboardingResult.onboardingMessage && !onboardingResult.shouldContinue) {
      addMessage(userId, 'user', userMessage);
      addMessage(userId, 'assistant', onboardingResult.onboardingMessage);
      return { response: onboardingResult.onboardingMessage, onboarding: onboardingResult };
    }

    // 2. Verificar caché
    const cached = getCachedResponse(userMessage);
    if (cached) {
      console.log('🎯 Cache HIT');
      // Check if we need to trigger onboarding for first message
      const lead = getLeadBySessionId(userId);
      const obState = getOnboardingState(userId);
      let suffix = '';
      if (!lead && !obState) {
        suffix = startOnboarding(userId);
      }
      return { response: cached + suffix };
    }

    // 3. Obtener o crear sesión
    const sessionId = getOrCreateSession(userId, channel);
    addMessage(sessionId, 'user', userMessage);

    try {
      // 4. Esperar el rate limit antes de CUALQUIER llamada a Gemini
      await rateLimitDelay();

      // 5. Recuperar contexto relevante (esto llama a Gemini Embeddings)
      console.log('🔍 Buscando contexto relevante...');
      const { context, products, categories } = await retrieveContext(userMessage);
      console.log(`📄 Contexto recuperado (${context.length} caracteres)`);

      // 6. Trackear productos y categorías consultados (no invasivo)
      for (const product of products) {
        logProductQuery(product, userId, channel);
      }
      const trackedCategories = new Set<string>();
      for (const category of categories) {
        if (!trackedCategories.has(category)) {
          trackedCategories.add(category);
          logCategoryQuery(category, userId, channel);
        }
      }

      if (products.length > 0) {
        console.log(`📦 Productos trackeados: ${products.join(', ')}`);
      }
      if (trackedCategories.size > 0) {
        console.log(`📁 Categorías trackeadas: ${[...trackedCategories].join(', ')}`);
      }

      // 7. Generar respuesta con Gemini Flash
      console.log('🤖 Generando respuesta con Gemini Flash...');
      
      const client = getNextClient();
      const response = await client.models.generateContent({
        model: config.gemini.model,
        contents: `CONTEXTO:\n${context}\n\nPREGUNTA: ${userMessage}`,
        config: {
          systemInstruction: config.systemPrompt,
          temperature: 0.3,
          maxOutputTokens: 800,
        },
      });

      let responseText = response.text || 'No se pudo generar una respuesta.';

      console.log(`✅ Respuesta generada (${responseText.length} caracteres)`);

      // 8. Guardar en caché
      setCachedResponse(userMessage, responseText);

      // 9. Verificar si necesita onboarding (primera interacción)
      const lead = getLeadBySessionId(userId);
      const obState = getOnboardingState(userId);
      if (!lead && !obState) {
        responseText += startOnboarding(userId);
      }

      // 10. Guardar mensaje del asistente en historial
      addMessage(sessionId, 'assistant', responseText);

      return { response: responseText };
    } catch (error: any) {
      console.error('❌ Error en el cerebro RAG:', error.message);

      if (error.message?.includes('API_KEY')) {
        return { response: '⚠️ Error con la API Key de Gemini. Verifica que sea válida.' };
      }

      if (error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
        return { response: '⚠️ Se alcanzó el límite de la API de Gemini. Intenta de nuevo en un momento.' };
      }

      return { response: '⚠️ Hubo un error procesando tu consulta. Por favor intenta de nuevo en unos momentos.' };
    }
  });
}

// Pre-cargar documentos al importar
loadDocuments().catch(e => {
  console.warn('⚠️  No se pudieron pre-cargar los documentos:', e.message);
});
