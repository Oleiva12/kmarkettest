import TelegramBot from 'node-telegram-bot-api';
import { askBrain, processOnboarding, startOnboarding } from '../core/brain.js';
import { config } from '../config/settings.js';
import { getOnboardingState, getLeadBySessionId, db } from '../core/cache.js';

let bot: TelegramBot | null = null;

// Map to track userId -> chatId for Telegram
const chatIdMap = new Map<string, number>();

function formatForTelegram(text: string): string {
  let formatted = text;
  // 1. Escapar HTML entities primero
  formatted = formatted.replace(/&/g, '&amp;')
                       .replace(/</g, '&lt;')
                       .replace(/>/g, '&gt;');
  
  // 2. Bold: **text** -> <b>text</b>
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  
  // 3. Italic: *text* -> <i>text</i>
  formatted = formatted.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  
  // 4. Links: [text](url) -> <a href="url">text</a>
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  
  // Remove --- separators
  formatted = formatted.replace(/\n---\n/g, '\n');
  
  return formatted;
}

import { linkWebSessionToTelegram } from '../core/cache.js';

export function startTelegramBot() {
  if (!config.telegram.token) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN no configurado. Bot de Telegram deshabilitado.');
    return;
  }

  bot = new TelegramBot(config.telegram.token, { polling: true });
  console.log('🤖 Bot de Telegram iniciado (polling mode)');

  const mainKeyboard = {
    inline_keyboard: [
      [{ text: '📋 Ver Categorías', callback_data: 'cmd_categorias' }],
      [{ text: '📍 Ubicación y Contacto', callback_data: 'cmd_contacto' }]
    ]
  };

  // ─── Comando /start (Maneja Deep Links) ───
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || chatId.toString();
    const userName = msg.from?.first_name || 'amigo';
    const webSessionId = match ? match[1] : null;

    // Track chatId for admin messaging
    chatIdMap.set(userId, chatId);

    let welcomeExtra = '';

    if (webSessionId) {
      const linked = linkWebSessionToTelegram(userId, webSessionId);
      if (linked) {
        welcomeExtra = `\n\n✨ <i>¡Veo que vienes de la web! He vinculado tu sesión. Ya puedes continuar nuestra conversación aquí.</i>`;
      }
    }

    // Check if user already has a lead
    const existingLead = getLeadBySessionId(userId);
    const obState = getOnboardingState(userId);
    let onboardingPrompt = '';

    if (!existingLead && !obState) {
      onboardingPrompt = `\n\n📋 Para darte una mejor atención, ¿me compartes tu nombre?`;
      // Start onboarding
      startOnboarding(userId);
    }

    await bot!.sendMessage(chatId,
      `¡Hola ${userName}! 👋\n\n` +
      `Soy el asistente virtual de <b>K-Mart El Salvador</b> 🇸🇻\n\n` +
      `Puedo ayudarte con información sobre productos, categorías, y asesoramiento de compras.` +
      welcomeExtra +
      onboardingPrompt,
      { 
        parse_mode: 'HTML',
        reply_markup: mainKeyboard
      }
    );
  });

  // ─── Comando /help ───
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot!.sendMessage(chatId,
      `<b>Comandos disponibles:</b>\n\n` +
      `/start — Mensaje de bienvenida\n` +
      `/help — Ver esta ayuda\n` +
      `/categorias — Ver categorías de productos\n` +
      `/contacto — Datos de contacto\n\n` +
      `O simplemente escribe tu pregunta y te respondo. 💬`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── Comando /categorias ───
  bot.onText(/\/categorias/, async (msg) => {
    const chatId = msg.chat.id;
    await sendCategorias(chatId);
  });

  async function sendCategorias(chatId: number) {
    const catKeyboard = {
      inline_keyboard: [
        [{ text: '💄 Belleza', callback_data: 'cat_belleza' }, { text: '🛍️ Bolsa Plástica', callback_data: 'cat_bolsas' }],
        [{ text: '🍽️ Desechables', callback_data: 'cat_desechables' }, { text: '📦 Empaques', callback_data: 'cat_empaques' }],
        [{ text: '🧹 Limpieza', callback_data: 'cat_limpieza' }, { text: '🧻 Papel', callback_data: 'cat_papel' }],
        [{ text: '👟 Pasta y Betunes', callback_data: 'cat_betun' }, { text: '🕯️ Velas', callback_data: 'cat_velas' }]
      ]
    };

    await bot!.sendMessage(chatId,
      `<b>📋 Categorías del catálogo K-Mart:</b>\nSelecciona una categoría para más información:`,
      { parse_mode: 'HTML', reply_markup: catKeyboard }
    );
  }

  // ─── Comando /contacto ───
  bot.onText(/\/contacto/, async (msg) => {
    const chatId = msg.chat.id;
    await sendContacto(chatId);
  });

  async function sendContacto(chatId: number) {
    await bot!.sendMessage(chatId,
      `<b>📍 Contacto K-Mart El Salvador:</b>\n\n` +
      `🏢 Torre Quattro, Nivel 7\n` +
      `World Trade Center, Col. Escalón\n` +
      `San Salvador, El Salvador\n\n` +
      `📞 +503 2263 3127\n` +
      `✉️ ventas@kmart-elsalvador.com\n` +
      `🌐 https://kmart-elsalvador.com`,
      { parse_mode: 'HTML' }
    );
  }

  // ─── Callback Queries (Interacciones con Botones) ───
  bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    if (!message) return;

    const chatId = message.chat.id;
    const userId = callbackQuery.from.id.toString();

    // Acknowledge the callback
    await bot!.answerCallbackQuery(callbackQuery.id);

    if (data === 'cmd_categorias') {
      await sendCategorias(chatId);
    } else if (data === 'cmd_contacto') {
      await sendContacto(chatId);
    } else if (data === 'skip_phone') {
      // Handle skip phone during onboarding
      const onboardingResult = processOnboarding(userId, 'saltar', 'telegram');
      if (onboardingResult.onboardingMessage) {
        await bot!.sendMessage(chatId, onboardingResult.onboardingMessage, { parse_mode: 'HTML' });
      }
    } else if (data?.startsWith('cat_')) {
      const catMap: Record<string, string> = {
        'cat_belleza': 'Belleza', 'cat_bolsas': 'Bolsa Plástica', 'cat_desechables': 'Desechables',
        'cat_empaques': 'Empaques', 'cat_limpieza': 'Limpieza', 'cat_papel': 'Papel',
        'cat_betun': 'Pasta y Betunes', 'cat_velas': 'Velas'
      };
      const catName = catMap[data];
      if (catName) {
        // Enviar al cerebro como si el usuario hubiera escrito "Muestrame productos de X"
        await handleRagMessage(chatId, userId, `Muéstrame productos de la categoría ${catName}`);
      }
    }
  });

  // ─── Mensajes generales (RAG) ───
  bot.on('message', async (msg) => {
    // Ignorar comandos ya manejados
    if (msg.text?.startsWith('/')) return;
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString() || chatId.toString();

    // Track chatId for admin messaging
    chatIdMap.set(userId, chatId);

    // Check if in onboarding first
    const obState = getOnboardingState(userId);
    if (obState && obState.completed === 0 && obState.step !== 'none') {
      const onboardingResult = processOnboarding(userId, msg.text, 'telegram');
      if (onboardingResult.onboardingMessage && !onboardingResult.shouldContinue) {
        const replyMarkup = onboardingResult.skipPhoneButton
          ? { inline_keyboard: [[{ text: 'Saltar ⏭️', callback_data: 'skip_phone' }]] }
          : undefined;

        await bot!.sendMessage(chatId, onboardingResult.onboardingMessage, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
        return;
      }
    }

    await handleRagMessage(chatId, userId, msg.text);
  });

  async function handleRagMessage(chatId: number, userId: string, text: string) {
    // Enviar indicador "escribiendo..."
    await bot!.sendChatAction(chatId, 'typing');

    // Mantener el indicador de typing activo mientras procesa
    const typingInterval = setInterval(() => {
      bot!.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      const result = await askBrain(text, userId, 'telegram');

      clearInterval(typingInterval);

      // If admin took over, don't send AI response
      if (result.response === '__ADMIN_TAKEOVER__') {
        return;
      }

      // Convertir Markdown estándar de Gemini a HTML seguro de Telegram
      const htmlResponse = formatForTelegram(result.response);

      // Enviar respuesta con formato HTML
      await bot!.sendMessage(chatId, htmlResponse, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }).catch(async (e) => {
        console.warn('⚠️ Error enviando HTML, enviando sin formato fallback:', e.message);
        // Si falla el HTML (caracteres inválidos), enviar sin formato
        await bot!.sendMessage(chatId, result.response);
      });

    } catch (error: any) {
      clearInterval(typingInterval);
      console.error('Error en bot de Telegram:', error);
      await bot!.sendMessage(chatId,
        '⚠️ Hubo un error procesando tu mensaje. Por favor intenta de nuevo.'
      );
    }
  }

  // Error handling
  bot.on('polling_error', (error) => {
    console.error('Error de polling Telegram:', error.message);
  });
}

// ─── Send message from admin to Telegram user ───
export function sendTelegramMessage(sessionId: string, message: string): void {
  if (!bot) return;

  // Try chatIdMap first
  const chatId = chatIdMap.get(sessionId);
  if (chatId) {
    bot.sendMessage(chatId, `👤 *Agente K-Mart:*\n${message}`, { parse_mode: 'Markdown' }).catch(e => {
      console.error('Error enviando mensaje admin a Telegram:', e.message);
    });
    return;
  }

  // Try to find the user_id from the session (it's a Telegram numeric ID for telegram sessions)
  try {
    const session = (db as any).prepare('SELECT user_id, channel FROM chat_sessions WHERE id = ? OR user_id = ?').get(sessionId, sessionId) as any;
    if (session && session.channel === 'telegram') {
      const tgChatId = parseInt(session.user_id);
      if (!isNaN(tgChatId)) {
        bot.sendMessage(tgChatId, `👤 *Agente K-Mart:*\n${message}`, { parse_mode: 'Markdown' }).catch(e => {
          console.error('Error enviando mensaje admin a Telegram:', e.message);
        });
      }
    }
  } catch (e: any) {
    console.error('Error buscando sesión Telegram:', e.message);
  }
}
