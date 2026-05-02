import 'dotenv/config';
import { startWebServer } from './channels/web.js';
import { startTelegramBot } from './channels/telegram.js';
import { mountWhatsAppRoutes } from './channels/whatsapp.js';
import { cleanExpiredCache } from './core/cache.js';
import { app } from './channels/web.js';

console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   🏪  K-MART EL SALVADOR — RAG SYSTEM            ║
║                                                   ║
║   Powered by Gemini Flash + LlamaIndex.TS         ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
`);

// Limpiar caché expirado al inicio
cleanExpiredCache();

// Limpiar caché cada hora
setInterval(cleanExpiredCache, 60 * 60 * 1000);

// Montar rutas de WhatsApp en el servidor Express
mountWhatsAppRoutes(app);

// Iniciar servidor web
startWebServer();

// Iniciar bot de Telegram
startTelegramBot();

console.log('\n✅ Todos los canales están activos. El sistema está listo.');
console.log('📝 Escribe un mensaje al bot de Telegram o envía un POST a /chat');
