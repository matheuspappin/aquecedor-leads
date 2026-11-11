require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const classifier = require('./classifier');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5050;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://127.0.0.1:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'B6D711FCDE4D4FD5936544120E713976';
const DELAY_MIN_MS = parseInt(process.env.DELAY_MIN_MS) || 90000;
const DELAY_MAX_MS = parseInt(process.env.DELAY_MAX_MS) || 240000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
// Limite padrão de tolerância (timeout) para aguardar a resposta do lead (em horas)
const TIMEOUT_RESPOSTA_HORAS = parseInt(process.env.TIMEOUT_RESPOSTA_HORAS) || 24;
const INSTANCE_VENDEDOR = process.env.INSTANCE_VENDEDOR || 'vendedor_oficial';

const LEADS_FILE = path.join(__dirname, 'leads_aquecidos.json');

// Helper para obter parâmetros dinâmicos definidos pelo Super Admin no CRM
async function obterConfiguracaoSuperAdmin(key, defaultValue) {
    const { client } = getCrmSessionClient();
    if (!client) return defaultValue;
    try {
        const { data, error } = await client
            .from('system_settings')
            .select('value')
            .eq('key', key)
            .single();

        if (!error && data && data.value !== undefined && data.value !== null) {
            return data.value;
        }
    } catch (e) {}
    return defaultValue;
}

// ==========================================
// CONEXÃO COM O SUPABASE DO CRM & LEAD HUNTER
// ==========================================
let cachedOwnerId = null;
async function getOwnerAdminId(client) {
    if (cachedOwnerId) return cachedOwnerId;
    try {
        const { data } = await client.from('users').select('id').eq('role', 'owner').limit(1).maybeSingle();
        if (data?.id) {
            cachedOwnerId = data.id;
            return cachedOwnerId;
        }
    } catch (e) {}
    return null;
}

function getCrmSessionClient() {
    try {
        const sessionPath = path.join(os.homedir(), '.crm-session.json');
        let sessionData = {};
        if (fs.existsSync(sessionPath)) {
            try {
                sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
            } catch (parseErr) {}
        }

        const supabaseUrl = process.env.SUPABASE_URL || sessionData.supabaseUrl;
        const serviceKey = process.env.SUPABASE_KEY || sessionData.supabaseKey;

        if (supabaseUrl && serviceKey) {
            const client = createClient(supabaseUrl, serviceKey, {
                auth: { persistSession: false }
            });
            return {
                client,
                adminId: sessionData.user_id || cachedOwnerId || null,
                email: sessionData.email || 'admin@crm.com'
            };
        }
        return { client: null, adminId: null, email: null };
    } catch (e) {
        return { client: null, adminId: null, email: null };
    }
}

// ==========================================
// PERSISTÊNCIA LOCAL DE ESTADO & TIMEOUTS
// ==========================================
function carregarLeads() {
    if (fs.existsSync(LEADS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

function salvarLeads(leads) {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

function verificarTimeoutsLeads(leads) {
    let alterado = false;
    const agora = Date.now();
    for (const lead of leads) {
        if (lead.status === 'aguardando_resposta' && lead.dataDisparoComprador) {
            const horas = (agora - new Date(lead.dataDisparoComprador).getTime()) / (1000 * 60 * 60);
            if (horas >= TIMEOUT_RESPOSTA_HORAS) {
                lead.status = 'expirado_sem_resposta';
                lead.dataExpiracao = new Date().toISOString();
                alterado = true;
            }
        }
    }
    if (alterado) salvarLeads(leads);
    return leads;
}

// ==========================================
// LOGS EM TEMPO REAL (SERVER-SENT EVENTS)
// ==========================================
let logClients = [];
app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    logClients.push(res);
    req.on('close', () => {
        logClients = logClients.filter(c => c !== res);
    });
});

function sendLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
    logClients.forEach(c => {
        c.write(`data: ${JSON.stringify({ time, msg, type })}\n\n`);
    });
}

// ==========================================
// MOTOR DE SPINTAX
// ==========================================
function parseSpintax(text) {
    if (!text) return '';
    const regex = /\{([^{}]+)\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const options = match[1].split('|');
        const chosen = options[Math.floor(Math.random() * options.length)];
        text = text.replace(match[0], chosen);
        regex.lastIndex = 0;
    }
    return text;
}

// ==========================================
// HELPERS EVOLUTION API
// ==========================================
const evoHeaders = {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = () => Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;

// ==========================================
// ROTA DE SESSÃO DO SUPER ADMIN / CENTRAL
// ==========================================
app.get('/api/session', async (req, res) => {
    const { client, adminId, email } = getCrmSessionClient();
    let finalAdminId = adminId;
    let finalEmail = email;
    if (client && !finalAdminId) {
        finalAdminId = await getOwnerAdminId(client);
    }
    res.json({ email: finalEmail || 'Super Admin Central', user_id: finalAdminId || null });
});

// ==========================================
// ROTAS DE BUSCAS DO LEAD HUNTER (CENTRALIZADAS)
// ==========================================
app.get('/api/searches', async (req, res) => {
    const { client } = getCrmSessionClient();
    if (!client) {
        return res.status(400).json({ error: 'Sessão do Supabase não conectada.' });
    }

    try {
        // Carrega todas as buscas ativas mineradas no Lead Hunter (sem filtro restritivo de vendedor)
        const { data, error } = await client
            .from('scraped_searches')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        
        // Remove buscas que já sejam pacotes de aquecidos para não poluir a listagem
        const filtradas = (data || []).filter(s => 
            s.source !== 'aquecedor_leads' &&
            !s.query.includes('AQUECIDOS')
        );
        res.json({ searches: filtradas });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/searches/:id/leads', async (req, res) => {
    const { client } = getCrmSessionClient();
    if (!client) return res.status(400).json({ error: 'Supabase não conectado.' });

    try {
        const { data, error } = await client
            .from('scraped_leads')
            .select('*')
            .eq('search_id', req.params.id)
            .not('phone', 'is', null)
            .neq('phone', '');

        if (error) throw error;

        const semSite = (data || []).filter(l => l.has_website === false);
        res.json({ total: data?.length || 0, semSiteCount: semSite.length, leads: semSite });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// ROTAS DE STATUS EXCLUSIVAS DOS 4 CHIPS COMPRADORES
// ==========================================
app.get('/api/instances', async (req, res) => {
    try {
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, { headers: evoHeaders });
        const all = response.data || [];
        const buyers = ['comprador_1', 'comprador_2', 'comprador_3', 'comprador_4'];
        
        const filtered = buyers.map(name => {
            const found = all.find(i => i.name === name);
            return {
                name,
                status: found ? found.connectionStatus : 'offline',
                profileName: found ? found.profileName : null,
                number: found ? found.number : null,
            };
        });

        res.json({ instances: filtered });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/instance/connect/:name', async (req, res) => {
    const { name } = req.params;
    try {
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${name}`, { headers: evoHeaders });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: e.response ? e.response.data : e.message });
    }
});

// ==========================================
// CLASSIFICADOR DE RESPOSTAS (REGRAS PRÉ-CRIADAS VS GEMINI IA)
// ==========================================
app.get('/api/classifier/config', (req, res) => {
    res.json(classifier.getConfig());
});

app.post('/api/classifier/config', (req, res) => {
    const result = classifier.saveConfig(req.body);
    if (result.success) {
        sendLog(`⚙️ [Motor de Triagem] Configuração atualizada. Modo ativo: ${result.config.mode === 'gemini' ? 'Inteligência Artificial (Gemini)' : 'Regras de Respostas Pré-Criadas (Máquina de Vendas)'}`, 'system');
        res.json(result);
    } else {
        res.status(500).json({ error: result.error });
    }
});

app.post('/api/classifier/test', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto para teste é obrigatório' });
    try {
        const resultado = await classifier.testarClassificacao(text);
        res.json(resultado);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

async function classificarAusenciaSite(textoMensagem) {
    return await classifier.classificarAusenciaSite(textoMensagem, sendLog);
}

// ==========================================
// SINCRONIZADOR COM A MÁQUINA DE VENDAS NO SUPABASE
// ==========================================
async function sincronizarPacoteAquecidoSupabase(lead, distributionStatus = 'respondeu_maquina', scoreReasons = null) {
    const { client, adminId: sessionAdminId } = getCrmSessionClient();
    if (!client) return;

    try {
        const ownerId = sessionAdminId || await getOwnerAdminId(client) || lead.user_id || '00000000-0000-0000-0000-000000000000';
        const searchName = `🔥 AQUECIDOS: ${lead.searchQuery || 'Geral'}`;
        
        // 1. Busca se já existe o pacote central de aquecidos para essa busca
        let { data: existingSearch } = await client
            .from('scraped_searches')
            .select('*')
            .eq('source', 'aquecedor_leads')
            .eq('query', searchName)
            .maybeSingle();

        let targetSearchId = existingSearch?.id;

        if (!targetSearchId) {
            const { data: newSearch, error: searchErr } = await client
                .from('scraped_searches')
                .insert([{
                    user_id: ownerId,
                    query: searchName,
                    city: lead.cidade || 'Brasil',
                    source: 'aquecedor_leads',
                    total_leads: 1
                }])
                .select()
                .single();

            if (!searchErr && newSearch) {
                targetSearchId = newSearch.id;
            }
        } else {
            // Incrementa contador
            await client
                .from('scraped_searches')
                .update({ total_leads: (existingSearch.total_leads || 0) + 1 })
                .eq('id', targetSearchId);
        }

        if (targetSearchId) {
            const defaultScoreReasons = distributionStatus === 'respondeu_maquina'
                ? { motivo: "✅ Respondeu à oferta do Bot de Vendas — PRONTO PARA DESPACHO" }
                : { motivo: "Confirmou ausência de site para o chip comprador" };

            const { error: insertErr } = await client.from('scraped_leads').insert([{
                search_id: targetSearchId,
                user_id: ownerId,
                name: lead.nome,
                phone: lead.telefone,
                address: lead.cidade,
                has_website: false,
                has_phone: true,
                score: 100,
                score_reasons: scoreReasons || defaultScoreReasons,
                distribution_status: distributionStatus,
                lead_source: 'aquecedor_leads'  // isola do Lead Hunter via RLS
            }]);

            if (insertErr) {
                console.error('[sincronizarPacote] Erro ao inserir scraped_lead:', insertErr.message);
            } else {
                sendLog(`🔥 [Supabase] Lead ${lead.nome} criado no pacote "${searchName}" com status '${distributionStatus}' para o Gestor de Lotes!`, 'success');
            }
        }
    } catch (e) {
        console.error('Erro ao sincronizar pacote no Supabase:', e.message);
    }
}

// ==========================================
// DISPARO DO AQUECEDOR (4 CHIPS COMPRADORES)
// ==========================================
let aquecimentoAtivo = false;

app.post('/api/aquecimento/start', async (req, res) => {
    if (aquecimentoAtivo) {
        return res.status(400).json({ error: 'Um processo de aquecimento já está em andamento.' });
    }

    const { searchId, spintaxTemplate, csvLeads, source } = req.body;
    const { client, adminId } = getCrmSessionClient();

    let contatos = [];
    let searchMeta = null;
    const isCsvTest = source === 'csv' || (Array.isArray(csvLeads) && csvLeads.length > 0) || searchId === 'csv_test';

    if (isCsvTest) {
        if (!csvLeads || !Array.isArray(csvLeads) || csvLeads.length === 0) {
            return res.status(400).json({ error: 'Nenhum lead com telefone válido fornecido no CSV de teste.' });
        }

        contatos = csvLeads.map(l => {
            const rawPhone = String(l.telefone || l.phone || l.whatsapp || l.celular || '').replace(/\D/g, '');
            let formattedPhone = rawPhone;
            if ((rawPhone.length === 10 || rawPhone.length === 11) && !rawPhone.startsWith('55')) {
                formattedPhone = '55' + rawPhone;
            }

            return {
                name: l.nome || l.name || 'Contato Teste',
                phone: formattedPhone,
                address: l.cidade || l.city || l.endereco || l.metadata?.cidade || l.metadata?.city || 'Brasil',
                company: l.empresa || l.company || l.metadata?.empresa || l.metadata?.company || null,
                user_id: adminId || null,
                has_website: false,
                is_test: true
            };
        }).filter(c => c.phone && c.phone.length >= 10);

        searchMeta = {
            id: 'csv_test',
            query: 'Teste CSV Controlado',
            city: 'Ambiente de Teste'
        };
    } else if (searchId && client) {
        const { data: sData } = await client.from('scraped_searches').select('*').eq('id', searchId).single();
        searchMeta = sData;

        const { data, error } = await client
            .from('scraped_leads')
            .select('*')
            .eq('search_id', searchId)
            .not('phone', 'is', null)
            .neq('phone', '');

        if (error) return res.status(500).json({ error: error.message });
        contatos = (data || []).filter(l => l.has_website === false);
    }

    if (contatos.length === 0) {
        return res.status(400).json({ 
            error: isCsvTest 
                ? 'Nenhum contato com telefone válido (mínimo 10 dígitos com DDD) encontrado no CSV.' 
                : 'Nenhum lead elegível sem site encontrado para este pacote.' 
        });
    }

    // Busca instâncias ativas dos compradores
    const instancesRes = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, { headers: evoHeaders });
    const allInstances = instancesRes.data || [];
    const activeBuyers = allInstances
        .filter(i => i.name.startsWith('comprador_') && i.connectionStatus === 'open')
        .map(i => i.name);

    if (activeBuyers.length === 0) {
        return res.status(400).json({ error: 'Nenhum dos 4 chips compradores está conectado via QR Code!' });
    }

    aquecimentoAtivo = true;
    res.json({
        message: isCsvTest 
            ? `Iniciando aquecimento de TESTE com ${contatos.length} contato(s) CSV usando ${activeBuyers.length} chip(s) comprador(es).`
            : `Iniciando aquecimento de ${contatos.length} leads com ${activeBuyers.length} chip(s) comprador(es).`,
        total: contatos.length
    });

    (async () => {
        sendLog(`🚀 --- INICIANDO AQUECIMENTO ${isCsvTest ? 'DE TESTE (CSV CONTROLADO)' : 'DE PACOTE LEAD HUNTER'} (${contatos.length} CONTATOS) ---`, 'system');
        const dbLeads = carregarLeads();
        let buyerIdx = 0;

        for (let i = 0; i < contatos.length; i++) {
            if (!aquecimentoAtivo) break;

            const lead = contatos[i];
            let cleanPhone = (lead.phone || '').replace(/\D/g, '');
            // Normaliza o prefixo 55 (Brasil) — igual ao tratamento do CSV
            if (cleanPhone.length === 10 || cleanPhone.length === 11) {
                cleanPhone = '55' + cleanPhone;
            }
            if (!cleanPhone || cleanPhone.length < 12) {
                sendLog(`⚠️ Número inválido ignorado (${lead.phone || 'vazio'}) para ${lead.name || 'lead'}`, 'warning');
                continue;
            }

            const existingIdx = dbLeads.findIndex(l => l.telefone === cleanPhone);
            if (existingIdx >= 0) {
                if (isCsvTest) {
                    sendLog(`[Teste CSV] Resetando registro anterior do telefone ${cleanPhone} para novo ciclo de teste...`, 'info');
                    dbLeads.splice(existingIdx, 1);
                } else {
                    continue;
                }
            }

            const instance = activeBuyers[buyerIdx % activeBuyers.length];
            buyerIdx++;

            const primeiroNome = lead.name ? lead.name.split(' ')[0] : 'lá';
            let template = spintaxTemplate || `{Olá|Oi|Boa tarde}! {Vi o trabalho de vocês no Google|Achei o perfil da empresa de vocês} e achei muito bom. Vocês teriam um {site|catálogo online} para eu ver {fotos dos serviços|mais detalhes e valores} com calma?`;
            
            template = template.replace(/{nome}/gi, primeiroNome);
            template = template.replace(/{empresa}/gi, lead.company || lead.name || 'sua empresa');
            template = template.replace(/{cidade}/gi, lead.address || searchMeta?.city || 'sua região');

            const mensagemFinal = parseSpintax(template);

            try {
                // Simula digitação por 4 segundos
                await axios.post(`${EVOLUTION_API_URL}/chat/sendPresence/${instance}`, {
                    number: cleanPhone, presence: "composing", delay: 4000
                }, { headers: evoHeaders }).catch(() => {});

                await sleep(4000);

                await axios.post(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
                    number: cleanPhone, text: mensagemFinal
                }, { headers: evoHeaders });

                sendLog(`[${instance}] Pergunta de comprador enviada -> ${lead.name || cleanPhone} (${cleanPhone})`, 'success');

                dbLeads.push({
                    nome: lead.name || 'Lead Teste',
                    telefone: cleanPhone,
                    cidade: lead.address || searchMeta?.city || null,
                    empresa: lead.company || null,
                    nicho: searchMeta?.query || (isCsvTest ? 'Teste CSV Controlado' : 'geral'),
                    searchQuery: searchMeta?.query || (isCsvTest ? 'Teste CSV Controlado' : null),
                    searchId: isCsvTest ? 'csv_test' : searchId,
                    vendorId: lead.user_id || adminId,
                    chipComprador: instance,
                    dataDisparoComprador: new Date().toISOString(),
                    status: 'aguardando_resposta',
                    mensagemComprador: mensagemFinal,
                    origem: isCsvTest ? 'csv_teste' : 'lead_hunter'
                });
                salvarLeads(dbLeads);

            } catch (err) {
                sendLog(`❌ Erro no envio para ${lead.name}: ${err.message}`, 'error');
            }

            if (i < contatos.length - 1 && aquecimentoAtivo) {
                const delay = isCsvTest ? 10000 : getRandomDelay();
                sendLog(isCsvTest ? `[Teste CSV] Aguardando 10s antes do próximo contato de teste...` : `Aguardando ${(delay/1000).toFixed(0)}s antes do próximo contato...`, 'info');
                await sleep(delay);
            }
        }

        aquecimentoAtivo = false;
        sendLog('🏁 --- CICLO DE PERGUNTAS FINALIZADO ---', 'system');
        sendLog('📡 [Webhook] O sistema continua rodando em segundo plano e aguardando as respostas dos leads...', 'info');
    })();
});

app.post('/api/aquecimento/stop', (req, res) => {
    aquecimentoAtivo = false;
    res.json({ success: true });
});

// ==========================================
// WEBHOOK (ESCUTA RESPOSTAS DOS 4 CHIPS COMPRADORES)
// ==========================================
app.post('/webhook/aquecedor', async (req, res) => {
    res.json({ received: true });
    console.log('--- WEBHOOK RECEBIDO ---', JSON.stringify(req.body, null, 2));

    try {
        // Log completo do payload RAW para diagnóstico
        const rawBody = req.body;
        console.log('=== WEBHOOK RAW RECEBIDO ===');
        console.log(JSON.stringify(rawBody, null, 2));
        console.log('===========================');

        // A Evolution API pode enviar como objeto único ou como array
        const payloads = Array.isArray(rawBody) ? rawBody : [rawBody];

        for (const payload of payloads) {
            await processarPayloadWebhook(payload);
        }
    } catch (e) {
        console.error('Erro no webhook central:', e.message);
    }
});

function normalizarNomeParaMatch(nome) {
    if (!nome) return '';
    return String(nome)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(psicologa|psicologo|consultorio|clinica|terapia|coach|de|e|da|do|dos|das|porto|alegre|espaco|saude|salton|dipp)\b/gi, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function encontrarLead(leads, cleanPhone, remoteJid, pushName) {
    // 1. Telefone direto (se não for LID e tiver pelo menos 8 dígitos)
    if (!remoteJid?.endsWith('@lid') && cleanPhone && cleanPhone.length >= 8) {
        const idx = leads.findIndex(l => {
            const t = (l.telefone || '').replace(/\D/g, '');
            return t.includes(cleanPhone) || cleanPhone.includes(t) || (t.slice(-8) === cleanPhone.slice(-8));
        });
        if (idx >= 0) return idx;
    }

    // 2. LID já gravado anteriormente
    if (remoteJid?.endsWith('@lid')) {
        const idxLid = leads.findIndex(l => l.remoteJidLid === remoteJid);
        if (idxLid >= 0) return idxLid;
    }

    // 3. Match por pushName (para contas WhatsApp que enviam com privacidade/LID)
    if (pushName) {
        const pushNorm = normalizarNomeParaMatch(pushName);
        const pushWords = pushNorm.split(' ').filter(w => w.length >= 3);

        let bestIdx = -1;
        let bestScore = 0;

        leads.forEach((lead, idx) => {
            const leadNorm = normalizarNomeParaMatch(lead.nome);
            const leadWords = leadNorm.split(' ').filter(w => w.length >= 3);
            const common = pushWords.filter(w => leadWords.some(lw => lw.includes(w) || w.includes(lw)));

            if (common.length > bestScore && common.length >= 1) {
                bestScore = common.length;
                bestIdx = idx;
            }
        });

        if (bestIdx >= 0) {
            if (remoteJid?.endsWith('@lid')) {
                leads[bestIdx].remoteJidLid = remoteJid;
            }
            return bestIdx;
        }
    }

    return -1;
}

async function processarPayloadWebhook(payload) {
    try {
        // Suporte a diferentes formatos da Evolution API
        const event = (payload.event || payload.type || '').toLowerCase().replace('.', '_');
        const instance = payload.instance || payload.instanceName || '';
        const msgData = payload.data || payload;

        if (!['messages_upsert', 'message_upsert', 'messages.upsert'].includes(event) && event !== '') {
            if (event) {
                sendLog(`[Webhook] Evento ignorado: ${event}`, 'info');
                return;
            }
        }

        if (!msgData) return;

        const key = msgData.key || msgData.message?.key || {};
        if (key.fromMe === true) return;

        const remoteJid = key.remoteJid || '';
        if (!remoteJid || remoteJid.includes('@g.us')) return;

        const cleanPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
        const pushName = (msgData.pushName || payload.pushName || '').trim();
        
        // Extrair texto da mensagem - tenta todas as estruturas conhecidas
        const m = msgData.message || {};
        const messageText = 
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            msgData.body ||
            msgData.text ||
            '';
        
        if (!messageText) {
            sendLog(`[Webhook] Mensagem recebida de ${pushName || cleanPhone} mas sem texto extraível. Tipo: ${Object.keys(m).join(', ')}`, 'warning');
            return;
        }

        sendLog(`[Webhook] 📩 Mensagem recebida! Chip: ${instance} | De: ${pushName || cleanPhone} (${remoteJid}) | Texto: "${messageText}"`, 'info');

        // ----------------------------------------------------
        // 1. SE A MENSAGEM RECEBIDA VEIO PARA O BOT DE VENDAS
        // ----------------------------------------------------
        if (instance === INSTANCE_VENDEDOR) {
            const leads = carregarLeads();
            const leadIdx = encontrarLead(leads, cleanPhone, remoteJid, pushName);
            if (leadIdx >= 0) {
                const lead = leads[leadIdx];
                lead.statusOferta = 'respondido';
                lead.respostaAoVendedor = messageText;
                lead.dataRespostaVendedor = new Date().toISOString();
                salvarLeads(leads);

                sendLog(`🎉 [RESPOSTA AO BOT DE VENDAS!] ${lead.nome}: "${messageText}". Notificado Super Admin para despachar ao Closer!`, 'success');

                // Notifica o Super Admin no CRM com link para o Gestor de Lotes
                const { client } = getCrmSessionClient();
                if (client) {
                    try {
                        await sincronizarPacoteAquecidoSupabase(
                            lead,
                            'respondeu_maquina',
                            {
                                motivo: "✅ Respondeu à oferta do Bot de Vendas — PRONTO PARA DESPACHO",
                                resposta: messageText,
                                dataResposta: new Date().toISOString()
                            }
                        );

                        const { data: owners } = await client.from('users').select('id').eq('role', 'owner');
                        if (owners && owners.length > 0) {
                            const notifs = owners.map(o => ({
                                user_id: o.id,
                                title: `🚨 ${lead.nome} respondeu ao Bot de Vendas — Despachar Agora!`,
                                message: `"${messageText}" — ${lead.nome} (${cleanPhone}) está QUENTE! Acesse o Gestor de Lotes, filtre por "Responderam" e despache para um vendedor imediatamente.`,
                                type: 'success',
                                link: '/vendas/lotes'
                            }));
                            await client.from('notifications').insert(notifs);
                        }
                    } catch (crmErr) {
                        console.error('Erro ao notificar Super Admin no CRM:', crmErr.message);
                    }
                }
            }
            return;
        }

        // ----------------------------------------------------
        // 2. RESPOSTA PARA OS CHIPS COMPRADORES (AQUECEDOR)
        // ----------------------------------------------------
        const leads = carregarLeads();
        const leadIdx = encontrarLead(leads, cleanPhone, remoteJid, pushName);
        if (leadIdx < 0) {
            sendLog(`⚠️ [Webhook] Mensagem de ${pushName || cleanPhone} (${remoteJid}) não corresponde a nenhum lead ativo do aquecedor.`, 'warning');
            return;
        }

        const lead = leads[leadIdx];
        if (lead.status !== 'aguardando_resposta') {
            if (lead.status === 'expirado_sem_resposta') {
                sendLog(`⏳ [Resposta Tardia Ignorada] ${lead.nome} respondeu após o limite de ${TIMEOUT_RESPOSTA_HORAS}h. Mensagem ignorada pelo comprador.`, 'warning');
            }
            return;
        }

        // Checar se o tempo limite de resposta do lead expirou (ex: 24h)
        if (lead.dataDisparoComprador) {
            const horasDesdeDisparo = (Date.now() - new Date(lead.dataDisparoComprador).getTime()) / (1000 * 60 * 60);
            if (horasDesdeDisparo >= TIMEOUT_RESPOSTA_HORAS) {
                lead.status = 'expirado_sem_resposta';
                lead.dataExpiracao = new Date().toISOString();
                lead.respostaTardia = messageText;
                salvarLeads(leads);
                sendLog(`⏳ [Tempo Limite Expirado] ${lead.nome} respondeu após ${horasDesdeDisparo.toFixed(1)}h (limite: ${TIMEOUT_RESPOSTA_HORAS}h). O comprador não responderá.`, 'warning');
                return;
            }
        }

        sendLog(`[Resposta do Lead no ${instance}] ${lead.nome}: "${messageText || '(mídia sem texto)'}"`, 'info');
        const analise = await classificarAusenciaSite(messageText || '');

        lead.motivoTriagem = analise.reason;
        lead.metodoTriagem = analise.method;
        lead.respostaAoComprador = messageText || '(mídia sem texto)';
        lead.dataResposta = new Date().toISOString();

        // 1. Respondeu que JÁ POSSUI SITE (ou link detectado) -> Descarte
        if (analise.type === 'com_site') {
            lead.status = 'com_site';
            lead.statusOferta = 'descartado';
            salvarLeads(leads);
            sendLog(`ℹ️ [COM SITE / DESCARTADO] ${lead.nome} informou ter site ou link detectado (${analise.reason}). Descartado da Máquina de Vendas.`, 'info');
            return;
        }

        // 2. Respondeu DIRETAMENTE que NÃO TEM SITE (ou termo pré-criado de ausência) -> Aquecido direto
        if (analise.type === 'sem_site' || analise.match === true) {
            lead.status = 'aquecido';
            lead.dataAquecimento = new Date().toISOString();

            // Agendamento do Bot de Vendas respeitando a regra do Super Admin
            const delayHorasRaw = await obterConfiguracaoSuperAdmin('bot_oferta_delay_horas', 24);
            const delayHoras = parseInt(delayHorasRaw) || 24;
            lead.dataAgendamentoOferta = new Date(Date.now() + (delayHoras * 3600000)).toISOString();
            lead.statusOferta = 'aguardando_delay_oferta';
            lead.delayHorasConfigurado = delayHoras;
            salvarLeads(leads);

            sendLog(`🔥 [AQUECIDO DIRETO!] ${lead.nome} confirmou ausência de site! (${analise.reason}). Encaminhado à Máquina de Vendas.`, 'success');
            sendLog(`⏱️ [Máquina de Vendas] Bot agendado para ${lead.nome} em ${delayHoras}h (${new Date(lead.dataAgendamentoOferta).toLocaleString('pt-BR')}).`, 'info');
            return;
        }

        // 3. Resposta INCONCLUSIVA (dúvidas, "quem é?", neutro, mídia sem texto) -> Aguarda Triagem Manual
        // O chip comprador mantém silêncio total. O lead fica na fila para análise manual do usuário no painel.
        lead.status = 'pendente_triagem';
        lead.statusOferta = 'aguardando_triagem';
        salvarLeads(leads);

        sendLog(`🤔 [TRIAGEM MANUAL NECESSÁRIA] ${lead.nome} respondeu de forma inconclusiva: "${messageText || '(mídia sem texto)'}". Disponível na Mesa de Triagem para sua decisão.`, 'warning');
        return;
    } catch (e) {
        console.error('Erro ao processar payload do webhook:', e.message);
    }
}



// ==========================================
// MOTOR AUTOMÁTICO DO BOT DE VENDAS (MÁQUINA DE VENDAS)
// ==========================================
async function processarFilaBotVendas() {
    try {
        const botStatus = await obterConfiguracaoSuperAdmin('bot_vendas_status', 'active');
        if (botStatus === 'paused') {
            return; // Super Admin pausou o Bot
        }

        const leads = carregarLeads();
        let alterado = false;
        const agora = Date.now();
        const scriptsNicho = await obterConfiguracaoSuperAdmin('bot_scripts_nicho', {});
        const followupScripts = await obterConfiguracaoSuperAdmin('bot_followup_scripts_nicho', {});
        const timeoutAntivacuoRaw = await obterConfiguracaoSuperAdmin('bot_antivacuo_timeout_horas', 24);
        const timeoutAntivacuoHoras = parseInt(timeoutAntivacuoRaw) || 24;

        for (const lead of leads) {
            const cleanPhone = (lead.telefone || '').replace(/\D/g, '');
            if (!cleanPhone || cleanPhone.length < 10) continue;

            // 1. DISPARO DA OFERTA (Após o delay de espera configurado pelo Super Admin)
            if (lead.statusOferta === 'aguardando_delay_oferta' && lead.dataAgendamentoOferta) {
                if (agora >= new Date(lead.dataAgendamentoOferta).getTime()) {
                    const nichoNormalizado = (lead.nicho || lead.searchQuery || 'geral').toLowerCase();
                    let nichoKey = 'geral';
                    if (nichoNormalizado.includes('estét') || nichoNormalizado.includes('estet')) nichoKey = 'estetica';
                    else if (nichoNormalizado.includes('psic')) nichoKey = 'psicologia';
                    else if (nichoNormalizado.includes('odont') || nichoNormalizado.includes('dentist')) nichoKey = 'odontologia';
                    else if (nichoNormalizado.includes('advog')) nichoKey = 'advocacia';

                    let template = (scriptsNicho && scriptsNicho[nichoKey]) || (scriptsNicho && scriptsNicho['geral']) ||
                        'Olá! Acompanho o trabalho da {empresa} aqui em {cidade}. Desenvolvemos sites profissionais de alta conversão para o seu segmento. Gostaria de ver uma demonstração de como estruturamos esse modelo?';

                    const primeiroNome = lead.nome ? lead.nome.split(' ')[0] : 'lá';
                    template = template.replace(/{nome}/gi, primeiroNome);
                    template = template.replace(/{empresa}/gi, lead.nome || 'sua empresa');
                    template = template.replace(/{cidade}/gi, lead.cidade || 'sua região');
                    const mensagemFinal = parseSpintax(template);

                    try {
                        // Simula digitação por 4 segundos
                        await axios.post(`${EVOLUTION_API_URL}/chat/sendPresence/${INSTANCE_VENDEDOR}`, {
                            number: cleanPhone, presence: "composing", delay: 4000
                        }, { headers: evoHeaders }).catch(() => {});

                        await sleep(4000);

                        await axios.post(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE_VENDEDOR}`, {
                            number: cleanPhone, text: mensagemFinal
                        }, { headers: evoHeaders });

                        lead.statusOferta = 'oferta_enviada';
                        lead.dataDisparoOferta = new Date().toISOString();
                        lead.mensagemOfertaEnviada = mensagemFinal;
                        alterado = true;

                        sendLog(`🚀 [Bot de Vendas] Oferta automática disparada para ${lead.nome} via ${INSTANCE_VENDEDOR}!`, 'success');
                        await sleep(3000);
                    } catch (err) {
                        sendLog(`⚠️ [Bot de Vendas] Falha ao enviar oferta para ${lead.nome} via ${INSTANCE_VENDEDOR}: ${err.message}`, 'error');
                    }
                }
            }

            // 2. RÉGUA ANTI-VÁCUO DO BOT (Se não responder em X horas de vácuo)
            if (lead.statusOferta === 'oferta_enviada' && !lead.retomadaEnviada && lead.dataDisparoOferta) {
                const horasDesdeOferta = (agora - new Date(lead.dataDisparoOferta).getTime()) / (1000 * 60 * 60);
                if (horasDesdeOferta >= timeoutAntivacuoHoras) {
                    const nichoNormalizado = (lead.nicho || lead.searchQuery || 'geral').toLowerCase();
                    let nichoKey = 'geral';
                    if (nichoNormalizado.includes('estét') || nichoNormalizado.includes('estet')) nichoKey = 'estetica';
                    else if (nichoNormalizado.includes('psic')) nichoKey = 'psicologia';

                    let template = (followupScripts && followupScripts[nichoKey]) || (followupScripts && followupScripts['geral']) ||
                        'Olá {nome}, tudo bem? Imagino que a rotina aí na {empresa} esteja bem corrida! Passando só para confirmar se conseguiu ver a mensagem anterior que enviei sobre o site? Um abraço!';

                    const primeiroNome = lead.nome ? lead.nome.split(' ')[0] : 'lá';
                    template = template.replace(/{nome}/gi, primeiroNome);
                    template = template.replace(/{empresa}/gi, lead.nome || 'sua empresa');
                    template = template.replace(/{cidade}/gi, lead.cidade || 'sua região');
                    const mensagemFinal = parseSpintax(template);

                    try {
                        await axios.post(`${EVOLUTION_API_URL}/chat/sendPresence/${INSTANCE_VENDEDOR}`, {
                            number: cleanPhone, presence: "composing", delay: 4000
                        }, { headers: evoHeaders }).catch(() => {});

                        await sleep(4000);

                        await axios.post(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE_VENDEDOR}`, {
                            number: cleanPhone, text: mensagemFinal
                        }, { headers: evoHeaders });

                        lead.retomadaEnviada = true;
                        lead.dataRetomadaEnviada = new Date().toISOString();
                        lead.mensagemRetomadaEnviada = mensagemFinal;
                        alterado = true;

                        sendLog(`⚡ [Bot Anti-Vácuo] Retomada disparada para ${lead.nome} após ${horasDesdeOferta.toFixed(0)}h de vácuo!`, 'warning');
                        await sleep(3000);
                    } catch (err) {
                        sendLog(`⚠️ [Bot Anti-Vácuo] Falha ao enviar retomada para ${lead.nome}: ${err.message}`, 'error');
                    }
                }
            }
        }

        if (alterado) salvarLeads(leads);
    } catch (e) {
        console.error('Erro no loop do Bot de Vendas:', e.message);
    }
}

// Inicia o loop automático a cada 60 segundos
setInterval(processarFilaBotVendas, 60000);

// ==========================================
// LISTAGEM DE LEADS NO DASHBOARD
// ==========================================
app.get('/api/leads/stats', (req, res) => {
    const leads = verificarTimeoutsLeads(carregarLeads());
    res.json({
        total: leads.length,
        aguardandoComprador: leads.filter(l => l.status === 'aguardando_resposta').length,
        aquecidosProntos: leads.filter(l => l.status === 'aquecido').length,
        pendenteTriagem: leads.filter(l => l.status === 'pendente_triagem').length,
        expiradosSemResposta: leads.filter(l => l.status === 'expirado_sem_resposta').length,
        comSite: leads.filter(l => l.status === 'com_site' || l.status === 'descartado').length,
        inconclusivos: leads.filter(l => l.status === 'inconclusivo' || l.status === 'pendente_triagem').length,
        botOfertasAguardandoDelay: leads.filter(l => l.statusOferta === 'aguardando_delay_oferta').length,
        botOfertasEnviadas: leads.filter(l => l.statusOferta === 'oferta_enviada').length,
        botOfertasRespondidas: leads.filter(l => l.statusOferta === 'respondido').length,
        classifierMode: classifier.getConfig().mode,
        timeoutHoras: TIMEOUT_RESPOSTA_HORAS,
        list: leads
    });
});

// ==========================================
// ROTA DE TRIAGEM MANUAL DE ANÁLISE
// ==========================================
app.post('/api/leads/triagem', async (req, res) => {
    try {
        const { telefone, acao } = req.body;
        if (!telefone || !['aprovar', 'descartar'].includes(acao)) {
            return res.status(400).json({ error: 'Telefone e ação válida ("aprovar" ou "descartar") são obrigatórios.' });
        }

        const leads = carregarLeads();
        const cleanPhone = String(telefone).replace(/\D/g, '');
        const leadIdx = leads.findIndex(l => {
            const t = (l.telefone || '').replace(/\D/g, '');
            return t.includes(cleanPhone) || cleanPhone.includes(t) || (t.length >= 8 && cleanPhone.length >= 8 && t.slice(-8) === cleanPhone.slice(-8));
        });

        if (leadIdx < 0) {
            return res.status(404).json({ error: 'Lead não encontrado na base do aquecedor.' });
        }

        const lead = leads[leadIdx];

        if (acao === 'aprovar') {
            lead.status = 'aquecido';
            lead.dataAquecimento = new Date().toISOString();
            lead.motivoTriagem = (lead.motivoTriagem ? lead.motivoTriagem + ' | ' : '') + 'Aprovado manualmente na triagem';

            // Agendamento do Bot de Vendas respeitando a regra do Super Admin
            const delayHorasRaw = await obterConfiguracaoSuperAdmin('bot_oferta_delay_horas', 24);
            const delayHoras = parseInt(delayHorasRaw) || 24;
            lead.dataAgendamentoOferta = new Date(Date.now() + (delayHoras * 3600000)).toISOString();
            lead.statusOferta = 'aguardando_delay_oferta';
            lead.delayHorasConfigurado = delayHoras;

            salvarLeads(leads);
            sendLog(`🔥 [Triagem Manual] ${lead.nome} (${cleanPhone}) APROVADO manualmente como AQUECIDO! Agendado para Máquina de Vendas em ${delayHoras}h.`, 'success');
            return res.json({ success: true, lead, message: `${lead.nome} aprovado e enviado para a Máquina de Vendas!` });
        } else if (acao === 'descartar') {
            lead.status = 'com_site';
            lead.statusOferta = 'descartado';
            lead.motivoTriagem = (lead.motivoTriagem ? lead.motivoTriagem + ' | ' : '') + 'Descartado manualmente na triagem';

            salvarLeads(leads);
            sendLog(`🗑️ [Triagem Manual] ${lead.nome} (${cleanPhone}) DESCARTADO na triagem manual.`, 'info');
            return res.json({ success: true, lead, message: `${lead.nome} descartado com sucesso.` });
        }
    } catch (e) {
        console.error('Erro na triagem manual:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// CONFIGURAÇÃO AUTOMÁTICA DE WEBHOOKS
// ==========================================
async function configurarWebhooks() {
    try {
        const instancesRes = await axios.get(`${EVOLUTION_API_URL}/instance/fetchInstances`, { headers: evoHeaders });
        const allInstances = instancesRes.data || [];
        // O Evolution API roda no Docker, logo precisa acessar o Windows via host.docker.internal
        const myWebhookUrl = process.env.WEBHOOK_URL || `http://host.docker.internal:${PORT}/webhook/aquecedor`;
        
        // Vamos tentar configurar apenas pros chips "comprador_X" e "vendedor_oficial"
        const targetInstances = allInstances.filter(i => i.name.startsWith('comprador_') || i.name === INSTANCE_VENDEDOR);

        if (targetInstances.length === 0) return;

        sendLog(`📡 [Webhook] Configurando webhook automaticamente para ${targetInstances.length} chips...`, 'system');

        for (const instance of targetInstances) {
            try {
                // Formato Evolution API V1 e V2
                const payload = {
                    webhook: {
                        enabled: true,
                        url: myWebhookUrl,
                        byEvents: false,
                        base64: false,
                        events: ["MESSAGES_UPSERT"]
                    }
                };
                
                await axios.post(`${EVOLUTION_API_URL}/webhook/set/${instance.name}`, payload, { headers: evoHeaders });
                sendLog(`✅ [Webhook] Configurado com sucesso no chip: ${instance.name}`, 'success');
            } catch (err) {
                // Fallback para API V1 se V2 falhar
                try {
                    const payloadV1 = {
                        url: myWebhookUrl,
                        webhook_by_events: false,
                        webhook_base64: false,
                        events: ["MESSAGES_UPSERT"]
                    };
                    await axios.post(`${EVOLUTION_API_URL}/webhook/set/${instance.name}`, payloadV1, { headers: evoHeaders });
                    sendLog(`✅ [Webhook] Configurado com sucesso (V1) no chip: ${instance.name}`, 'success');
                } catch (e) {
                    sendLog(`❌ [Webhook] Falha ao configurar no chip ${instance.name}.`, 'error');
                }
            }
        }
    } catch (err) {
        console.error('Erro ao buscar instâncias para configurar webhook:', err.message);
    }
}

app.listen(PORT, async () => {
    console.log(`=======================================================`);
    console.log(`🔥 Aquecedor de Leads (4 Chips Compradores): http://localhost:${PORT}`);
    console.log(`   Evolution API em: ${EVOLUTION_API_URL}`);
    console.log(`=======================================================`);
    
    // Configura os webhooks automaticamente ao iniciar
    await configurarWebhooks();
});
