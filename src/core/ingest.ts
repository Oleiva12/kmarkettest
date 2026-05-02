import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config/settings.js';

// ─── Configurar Gemini ───
const genai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// ─── Tipos ───
interface RawProduct {
  url: string;
  title: string;
  breadcrumbs: string;
  price: string;
  sku: string;
  stock: string;
  type: string;
  last_updated: string;
  content: string;
}

// ─── Función de limpieza de Markdown ───
function cleanProductMarkdown(raw: RawProduct): string {
  let content = raw.content;

  // Remover la lista de categorías repetida
  content = content.replace(/\*\s+\[(?:Belleza|Bolsa Plastica|Desechables|Empaques|Limpieza|Papel|Pasta y betunes|Velas)\]\(https:\/\/kmart-elsalvador\.com\/product-category\/[^)]+\)\n?/g, '');

  // Remover iconos de zoom
  content = content.replace(/\[🔍\]\(#\)\n?/g, '');

  // Remover sección de "Productos relacionados"
  const relatedIdx = content.indexOf('Productos relacionados');
  if (relatedIdx !== -1) {
    content = content.substring(0, relatedIdx);
  }

  // Remover imágenes thumbnail (100x100)
  content = content.replace(/!\[[^\]]*\]\([^)]*100x100[^)]*\)\n?/g, '');
  
  // Remover listas numeradas de thumbnails  
  content = content.replace(/^\d+\.\s+!\[[^\]]*\].*$/gm, '');

  // Remover imágenes de galería duplicadas (600x600 links)
  content = content.replace(/\[!\[[^\]]*\]\([^)]*600x600[^)]*\)\]\([^)]*\)\n?/g, '');
  
  // Remover imágenes standalone extra
  const imgMatches = content.match(/!\[[^\]]*\]\([^)]*\)/g);
  if (imgMatches && imgMatches.length > 1) {
    for (let i = 1; i < imgMatches.length; i++) {
      content = content.replace(imgMatches[i], '');
    }
  }

  // Limpiar líneas vacías múltiples
  content = content.replace(/\n{3,}/g, '\n\n');

  // Extraer categoría
  let category = 'Sin categoría';
  const catMatch = content.match(/Categoría:\s*\[([^\]]+)\]/);
  if (catMatch) {
    category = catMatch[1];
  }

  // Construir Markdown limpio
  const lines = [
    `# ${raw.title}`,
    `**Tipo:** ${raw.type}`,
    `**Categoría:** ${category}`,
  ];

  if (raw.price && raw.price !== 'N/A') {
    lines.push(`**Precio:** ${raw.price}`);
  }
  if (raw.sku && raw.sku !== 'N/A') {
    lines.push(`**SKU:** ${raw.sku}`);
  }
  if (raw.stock && raw.stock !== 'N/A') {
    lines.push(`**Disponibilidad:** ${raw.stock}`);
  }

  lines.push(`**Enlace:** ${raw.url}`);
  lines.push('');

  const descStart = content.indexOf(`# ${raw.title}`);
  if (descStart !== -1) {
    let desc = content.substring(descStart + `# ${raw.title}`.length).trim();
    desc = desc.replace(/Categoría:\s*\[[^\]]+\]\([^)]+\)\n?/g, '');
    desc = desc.trim();
    if (desc) {
      lines.push(desc);
    }
  } else {
    lines.push(content.trim());
  }

  return lines.join('\n').trim();
}

// ─── Chunking simple ───
function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  const words = text.split(/\s+/);
  if (words.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(' '));
    start += chunkSize - overlap;
  }

  return chunks;
}

// ─── Generar embeddings con Gemini ───
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  
  for (let i = 0; i < texts.length; i++) {
    const response = await genai.models.embedContent({
      model: config.gemini.embedModel,
      contents: texts[i],
    });

    // En la nueva API de @google/genai, los embeddings vienen en la propiedad embeddings y cada uno tiene values
    // Pero si enviamos un string, devuelve un solo embedding
    if (response.embeddings && response.embeddings[0]) {
      results.push(response.embeddings[0].values || []);
    } else {
      results.push([]);
    }

    if (i % 10 === 0) {
      console.log(`   📦 Embeddings: ${i}/${texts.length}`);
    }
    
    // Pequeña pausa para no golpear rate limit
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`   📦 Embeddings: ${texts.length}/${texts.length}`);
  return results;
}

// ─── Función principal de ingesta ───
export async function ingestData(): Promise<void> {
  console.log('📥 Iniciando ingesta de datos con Gemini embeddings...');

  const dataPath = config.paths.dataFile;
  if (!fs.existsSync(dataPath)) {
    throw new Error(`No se encontró el archivo de datos: ${dataPath}`);
  }

  const rawLines = fs.readFileSync(dataPath, 'utf-8').split('\n').filter(l => l.trim());
  console.log(`📄 Leyendo ${rawLines.length} registros del dataset...`);

  // Procesar y limpiar documentos
  interface DocChunk {
    text: string;
    metadata: Record<string, string>;
  }

  const chunks: DocChunk[] = [];

  for (const line of rawLines) {
    try {
      const raw: RawProduct = JSON.parse(line);
      if (raw.url.match(/\.(jpg|jpeg|png|gif|svg|webp)$/i)) continue;

      const cleanContent = cleanProductMarkdown(raw);

      let category = 'general';
      const catMatch = raw.content.match(/Categoría:\s*\[([^\]]+)\]/);
      if (catMatch) category = catMatch[1];

      const textChunks = chunkText(cleanContent);

      for (const chunk of textChunks) {
        chunks.push({
          text: chunk,
          metadata: {
            source: raw.url,
            title: raw.title,
            type: raw.type,
            category,
            price: raw.price,
            sku: raw.sku,
            stock: raw.stock,
            last_updated: raw.last_updated,
          },
        });
      }
    } catch (e) {
      // Ignorar líneas inválidas
    }
  }

  console.log(`✅ ${chunks.length} fragmentos preparados para indexación`);

  // Generar embeddings con Gemini
  console.log(`🧮 Generando embeddings con ${config.gemini.embedModel}...`);
  const texts = chunks.map(c => c.text);
  const embeddings = await getEmbeddings(texts);

  // Guardar en formato compatible
  const storagePath = config.paths.vectorStore;
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  // Construir stores
  const embeddingDict: Record<string, number[]> = {};
  const docStoreData: Record<string, any> = {};

  for (let i = 0; i < chunks.length; i++) {
    const id = `chunk-${i}`;
    embeddingDict[id] = embeddings[i];
    docStoreData[id] = {
      __data__: JSON.stringify({
        text: chunks[i].text,
        metadata: chunks[i].metadata,
      }),
    };
  }

  // Guardar vector store
  fs.writeFileSync(
    path.join(storagePath, 'vector_store.json'),
    JSON.stringify({ embeddingDict }),
    'utf-8'
  );

  // Guardar doc store
  fs.writeFileSync(
    path.join(storagePath, 'doc_store.json'),
    JSON.stringify({ 'docstore/data': docStoreData }),
    'utf-8'
  );

  console.log('💾 Índice vectorial guardado en disco.');
  console.log(`✅ Ingesta completada: ${chunks.length} fragmentos con embeddings de ${embeddings[0]?.length || 0} dimensiones.`);
}

// ─── Ejecutar como script independiente ───
if (process.argv[1]?.includes('ingest')) {
  ingestData()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('❌ Error durante ingesta:', e);
      process.exit(1);
    });
}
