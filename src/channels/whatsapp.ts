import express from 'express';
import { askBrain, processOnboarding, startOnboarding } from '../core/brain.js';
import { config } from '../config/settings.js';
import { getOnboardingState, getLeadBySessionId, isSessionTakenOver, addMessage, getOrCreateSession } from '../core/cache.js';

const WA = config.whatsapp;
const API_URL = `https://graph.facebook.com/${WA.apiVersion}/${WA.phoneNumberId}/messages`;

// ─── Enviar mensaje vía WhatsApp Cloud API ───
async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  if (!WA.accessToken || !WA.phoneNumberId) {
    console.warn('⚠️ WhatsApp no configurado (falta ACCESS_TOKEN o PHONE_NUMBER_ID)');
    return;
  }

  // WhatsApp formatting: convert Markdown
  let waText = text
    .replace(/\*\*(.*?)\*\*/g, '*$1*')  // **bold** → *bold*
    .replace(/•/g, '▸');

  // Limit to 4096 chars
  if (waText.length > 4096) waText = waText.substring(0, 4093) + '...';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: waText },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`❌ WhatsApp API error (${response.status}):`, err);
    } else {
      console.log(`✅ WhatsApp mensaje enviado a ${to}`);
    }
  } catch (error: any) {
    console.error('❌ Error enviando WhatsApp:', error.message);
  }
}

// ─── Enviar botón interactivo (para skip teléfono) ───
async function sendWhatsAppButtons(to: string, bodyText: string, buttons: Array<{ id: string; title: string }>): Promise<void> {
  if (!WA.accessToken) return;

  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      }),
    });
  } catch (error: any) {
    console.error('❌ Error enviando botones WhatsApp:', error.message);
  }
}

// ─── Exportar para uso desde admin takeover ───
export async function sendWhatsAppAdminMessage(phoneNumber: string, message: string): Promise<void> {
  await sendWhatsAppMessage(phoneNumber, `👤 *Agente K-Mart:*\n${message}`);
}

// ─── Montar rutas ───
export function mountWhatsAppRoutes(app: express.Express) {
  // Verificación de webhook (Meta requiere esto)
  app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WA.verifyToken) {
      console.log('✅ WhatsApp webhook verificado');
      return res.status(200).send(challenge);
    }

    console.warn('❌ WhatsApp webhook verificación fallida');
    res.sendStatus(403);
  });

  // Recibir mensajes entrantes
  app.post('/webhook/whatsapp', async (req, res) => {
    // Responder 200 inmediatamente (Meta requiere respuesta rápida)
    res.sendStatus(200);

    try {
      const body = req.body;

      if (body.object !== 'whatsapp_business_account') return;

      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // Ignorar status updates (delivered, read, etc.)
      if (value?.statuses) return;

      const message = value?.messages?.[0];
      if (!message) return;

      const phoneNumber = message.from;
      const contactName = value?.contacts?.[0]?.profile?.name || phoneNumber;

      let userMessage = '';

      // Soportar texto y botones interactivos
      if (message.type === 'text') {
        userMessage = message.text.body;
      } else if (message.type === 'interactive') {
        // Respuesta de botón
        userMessage = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
      } else if (message.type === 'button') {
        // Template button response
        userMessage = message.button?.text || '';
      } else {
        // Mensaje no soportado
        await sendWhatsAppMessage(phoneNumber, '📝 Por el momento solo puedo procesar mensajes de texto. ¿En qué te puedo ayudar?');
        return;
      }

      if (!userMessage.trim()) return;

      console.log(`📱 [WhatsApp] ${contactName} (${phoneNumber}): "${userMessage}"`);

      // Crear/obtener sesión
      const sessionId = getOrCreateSession(phoneNumber, 'whatsapp');

      // 1. Verificar si admin tomó control
      if (isSessionTakenOver(phoneNumber)) {
        addMessage(sessionId, 'user', userMessage);
        console.log(`🛑 WhatsApp ${phoneNumber} bajo control de admin`);
        return;
      }

      // 2. Verificar onboarding
      const obState = getOnboardingState(phoneNumber);
      if (obState && obState.completed === 0 && obState.step !== 'none') {
        const onResult = processOnboarding(phoneNumber, userMessage, 'whatsapp');
        if (onResult.onboardingMessage && !onResult.shouldContinue) {
          if (onResult.skipPhoneButton) {
            await sendWhatsAppButtons(phoneNumber, onResult.onboardingMessage, [
              { id: 'skip_phone', title: 'Saltar ⏭️' },
            ]);
          } else {
            await sendWhatsAppMessage(phoneNumber, onResult.onboardingMessage);
          }
          return;
        }
      }

      // 3. Procesar con RAG
      const result = await askBrain(userMessage, phoneNumber, 'whatsapp');

      if (result.response === '__ADMIN_TAKEOVER__') return;

      await sendWhatsAppMessage(phoneNumber, result.response);

    } catch (error: any) {
      console.error('❌ Error en webhook WhatsApp:', error.message);
    }
  });

  if (WA.accessToken && WA.phoneNumberId) {
    console.log(`📱 WhatsApp Business API activo (Phone ID: ${WA.phoneNumberId})`);
  } else {
    console.log('📱 Rutas WhatsApp montadas (webhook preparado, falta configurar token)');
  }
}
