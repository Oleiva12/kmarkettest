// Session Management
let sessionId = localStorage.getItem('kmart_session_id');
if (!sessionId) {
    sessionId = 'web-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('kmart_session_id', sessionId);
}

// Telegram Deep Link Setup
const TELEGRAM_BOT_USERNAME = 'KmarttestBot';
document.getElementById('btn-telegram').addEventListener('click', () => {
    const telegramUrl = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${sessionId}`;
    window.open(telegramUrl, '_blank');
});

// UI Elements
const chatWidget = document.getElementById('chat-widget');
const chatToggle = document.getElementById('chat-toggle');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
let isProcessing = false;

function openChat() {
    chatWidget.classList.remove('hidden');
    chatToggle.style.display = 'none';
    chatInput.focus();
}

function closeChat() {
    chatWidget.classList.add('hidden');
    chatToggle.style.display = 'flex';
}

function appendMessage(sender, text, options = {}) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender);
    
    if (sender === 'bot') {
        // Usa marked.js para convertir Markdown a HTML
        msgDiv.innerHTML = marked.parse(text);
    } else {
        msgDiv.textContent = text;
    }
    
    chatMessages.appendChild(msgDiv);

    // Add skip button if needed (onboarding phone step)
    if (options.skipPhoneButton) {
        const skipBtn = document.createElement('button');
        skipBtn.classList.add('skip-btn');
        skipBtn.textContent = 'Saltar ⏭️';
        skipBtn.onclick = () => {
            skipBtn.remove();
            chatInput.value = 'saltar';
            sendMessage();
        };
        chatMessages.appendChild(skipBtn);
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
    const typingDiv = document.createElement('div');
    typingDiv.classList.add('typing-indicator');
    typingDiv.id = 'typing-indicator';
    typingDiv.innerHTML = '<span></span><span></span><span></span>';
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTyping() {
    const typingDiv = document.getElementById('typing-indicator');
    if (typingDiv) typingDiv.remove();
}

let adminTakeover = false;
let lastMessageId = 0;
let pollInterval = null;

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isProcessing) return;

    chatInput.value = '';
    appendMessage('user', text);
    
    isProcessing = true;
    if (!adminTakeover) showTyping();

    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message: text, sessionId: sessionId })
        });

        const data = await response.json();
        hideTyping();
        
        if (data.adminTakeover) {
            adminTakeover = true;
            startPolling();
            // Don't show anything - admin will respond
        } else if (data.error) {
            appendMessage('bot', '⚠️ Ocurrió un error. Intenta de nuevo.');
        } else if (data.response) {
            const options = {};
            if (data.onboarding && data.onboarding.skipPhoneButton) {
                options.skipPhoneButton = true;
            }
            appendMessage('bot', data.response, options);
        }
    } catch (error) {
        hideTyping();
        appendMessage('bot', '🔌 Error de conexión con el servidor.');
    } finally {
        isProcessing = false;
        chatInput.focus();
    }
}

// Poll for admin messages when session is taken over
function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/chats-public/${sessionId}/poll?after=${lastMessageId}`);
            if (res.ok) {
                const messages = await res.json();
                messages.forEach(msg => {
                    if (msg.id > lastMessageId) {
                        lastMessageId = msg.id;
                        if (msg.content.includes('salido del chat')) {
                            adminTakeover = false;
                            clearInterval(pollInterval);
                            pollInterval = null;
                            appendMessage('bot', msg.content);
                        } else if (msg.content.includes('se ha unido')) {
                            appendMessage('bot', msg.content);
                        } else {
                            appendMessage('bot', '👤 ' + msg.content);
                        }
                    }
                });
            }
        } catch (e) {}
    }, 2000);
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        sendMessage();
    }
}
