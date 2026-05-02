import 'dotenv/config';
import * as path from 'path';

// Raíz del proyecto rag-system
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    embedModel: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-2',
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  port: parseInt(process.env.PORT || '3000', 10),
  cache: {
    ttlHours: parseInt(process.env.CACHE_TTL_HOURS || '24', 10),
  },
  paths: {
    vectorStore: path.join(PROJECT_ROOT, 'storage', 'vector-store'),
    sqliteDb: path.join(process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data'), 'kmart.db'),
    dataFile: path.join(PROJECT_ROOT, '..', 'final_dataset.jsonl'),
  },
  systemPrompt: `Eres el asistente virtual de K-Mart El Salvador, una distribuidora comercial salvadoreña con más de 35 años de experiencia. Tu nombre es "Kmart Asistente".

REGLAS:
1. Solo responde basándote en el CONTEXTO proporcionado abajo.
2. Si un producto NO aparece en el contexto, di: "No encontré ese producto en nuestro catálogo. ¿Te gustaría que busque algo similar o dejarnos tus datos para que un asesor te contacte?"
3. Responde siempre en español.
4. Usa Markdown estándar para formatear: **negritas**, *cursivas*, y enlaces [texto](url).
5. Para listas, usa SIEMPRE el caracter • (bullet) y nunca asteriscos al inicio de la línea.
6. Sé breve y directo. Máximo 3 párrafos.
7. Si te preguntan por precios, indica que K-Mart maneja precios por volumen y sugiere contactar a ventas@kmart-elsalvador.com o al +503 2263 3127.
8. Incluye siempre el enlace al producto cuando esté disponible.

INFORMACIÓN DE CONTACTO DE K-MART:
- Dirección: Torre Quattro, Nivel 7, World Trade Center, Colonia Escalón, San Salvador, El Salvador
- Teléfono: +503 2263 3127
- Email: ventas@kmart-elsalvador.com
- Web: https://kmart-elsalvador.com`,
};
