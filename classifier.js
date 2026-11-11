const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, 'classifier_config.json');

const DEFAULT_CONFIG = {
    mode: 'rules', // 'rules' (respostas pré-criadas / máquina de vendas) ou 'gemini' (IA)
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
        prompt: `O lead respondeu a uma mensagem de um cliente perguntando se ele tem um site da empresa.
Mensagem do lead: "{TEXTO}"
Responda ESTRITAMENTE em JSON: {"match": true|false, "reason": "..."}
(match = true se o lead confirmou que não tem site, que atende apenas pelo WhatsApp/Instagram, ou que não possui página).`
    },
    rules: {
        semSiteTermos: [
            "nao temos", "nao tenho", "nao possuimos", "nao possuo", "ainda nao", "infelizmente nao",
            "nao temos site", "sem site", "nao possuimos site", "nao trabalho com site", "nao fiz site", "nao tenho site", "nao temos pagina",
            "so instagram", "so insta", "apenas instagram", "apenas insta", "nosso insta", "temos insta", "veja no insta", "olha no insta", "pelo insta", "pelo instagram",
            "so whats", "so whatsapp", "apenas whats", "apenas whatsapp", "so por aqui", "so aqui", "direto por aqui", "atendemos por aqui",
            "posso te explicar", "posso te passar", "posso te mandar", "te mando por aqui", "te passo por aqui",
            "mando fotos por aqui", "passo fotos por aqui", "mando fotos aqui", "mando o catalogo", "mando em pdf", "te envio por aqui", "posso enviar por aqui",
            "estamos fazendo", "estamos criando", "em construcao", "estamos montando", "em breve teremos", "vamos fazer",
            "so presencial", "so na loja", "so no balcao"
        ],
        comSiteTermos: [
            "temos sim", "temos site", "nosso site", "pode olhar no site", "acesse nosso site", "no site tem", "pode ver no site",
            "link na bio", "ta na bio", "olha na bio", "esta na bio", "link da bio", "www.", "http://", "https://", ".com.br", ".com/"
        ]
    }
};

function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            return {
                mode: parsed.mode || 'rules',
                gemini: {
                    apiKey: parsed.gemini?.apiKey || process.env.GEMINI_API_KEY || '',
                    model: parsed.gemini?.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
                    prompt: parsed.gemini?.prompt || DEFAULT_CONFIG.gemini.prompt
                },
                rules: {
                    semSiteTermos: parsed.rules?.semSiteTermos || DEFAULT_CONFIG.rules.semSiteTermos,
                    comSiteTermos: parsed.rules?.comSiteTermos || DEFAULT_CONFIG.rules.comSiteTermos
                }
            };
        }
    } catch (e) {
        console.error('Erro ao ler classifier_config.json:', e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(newConfig) {
    try {
        const current = getConfig();
        const merged = {
            mode: newConfig.mode || current.mode || 'rules',
            gemini: {
                apiKey: newConfig.gemini?.apiKey !== undefined ? newConfig.gemini.apiKey : current.gemini.apiKey,
                model: newConfig.gemini?.model || current.gemini.model || 'gemini-3.1-flash-lite',
                prompt: newConfig.gemini?.prompt || current.gemini.prompt
            },
            rules: {
                semSiteTermos: Array.isArray(newConfig.rules?.semSiteTermos) ? newConfig.rules.semSiteTermos : current.rules.semSiteTermos,
                comSiteTermos: Array.isArray(newConfig.rules?.comSiteTermos) ? newConfig.rules.comSiteTermos : current.rules.comSiteTermos
            }
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
        return { success: true, config: merged };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function normalizarTexto(texto) {
    if (!texto || typeof texto !== 'string') return '';
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^\w\s\.\,\-\/\:\@]/g, ' ') // substitui caracteres exóticos por espaço
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Motor determinístico baseado em padrões de respostas reais da Máquina de Vendas
 */
function classificarPorRegras(textoMensagem, customRules = null) {
    if (!textoMensagem || typeof textoMensagem !== 'string') {
        return {
            match: false,
            type: 'vazio',
            reason: 'Mensagem vazia ou inválida',
            method: 'rules'
        };
    }

    const limpo = normalizarTexto(textoMensagem);
    const config = getConfig();
    const semSiteTermos = (customRules?.semSiteTermos || config.rules?.semSiteTermos || []).map(normalizarTexto);
    const comSiteTermos = (customRules?.comSiteTermos || config.rules?.comSiteTermos || []).map(normalizarTexto);

    // 1. Respostas diretas curtas: "Não", "Nao", "Não, não", "Infelizmente não", etc.
    const apenasNao = /^(nao|n|nop|nao nao|ainda nao|infelizmente nao)[\.\!\s]*$/i.test(limpo);
    if (apenasNao) {
        return {
            match: true,
            type: 'sem_site',
            reason: 'Negação direta confirmando ausência de site ("Não")',
            method: 'rules'
        };
    }

    // Resposta direta "Sim" ou "Temos sim" isolada
    const apenasSim = /^(sim|s|sim sim|temos sim|temos)[\.\!\s]*$/i.test(limpo);
    if (apenasSim) {
        return {
            match: false,
            type: 'com_site',
            reason: 'Confirmação direta de que possui site ("Sim")',
            method: 'rules'
        };
    }

    // 2. Afirmação explícita de ausência de site (ex: "não temos site", "sem site", "não trabalho com site")
    const afirmacoesAusenciaSite = [
        'nao temos site', 'sem site', 'nao tenho site', 'nao possuimos site',
        'nao trabalhamos com site', 'nao trabalho com site', 'nao fiz site', 'nao temos pagina'
    ];
    for (const termo of afirmacoesAusenciaSite) {
        if (limpo.includes(termo)) {
            return {
                match: true,
                type: 'sem_site',
                reason: `Declarou expressamente que não tem site ("${termo}")`,
                method: 'rules'
            };
        }
    }

    // 3. Verificação de presença de site / links (domínio web real ou termo 'comSite')
    // Não considera instagram.com ou wa.me como "site da empresa"
    const temUrlWeb = /(https?:\/\/(?!instagram|wa\.me|api\.whatsapp)[^\s]+|www\.[^\s]+|[a-z0-9-]+\.(com\.br|com(?![\w])|net|org|site|app|loja))\b/i.test(textoMensagem);
    const termoComSite = comSiteTermos.find(t => t && limpo.includes(t));

    // Se detectou link de site próprio ou termos como "temos sim", e não há negação expressa
    if ((temUrlWeb || termoComSite) && !limpo.includes('nao temos') && !limpo.includes('sem site')) {
        return {
            match: false,
            type: 'com_site',
            reason: `Detectado indicativo de site próprio (${temUrlWeb ? 'Link/URL' : termoComSite})`,
            method: 'rules'
        };
    }

    // 4. Verificação de termos pré-criados de ausência / alternativas (Instagram, WhatsApp, explicação manual, etc.)
    for (const termo of semSiteTermos) {
        if (termo && limpo.includes(termo)) {
            return {
                match: true,
                type: 'sem_site',
                reason: `Confirmou ausência de site por resposta pré-criada: "${termo}"`,
                method: 'rules'
            };
        }
    }

    // 5. Frases que começam com negação ao questionamento sobre site (ex: "Não, mas temos...", "Não, posso te explicar...", "Não, te mando...")
    const comecaComNao = /^(nao|n|ainda nao|infelizmente nao)(\b|,|\.|\!|\s)/i.test(limpo);
    if (comecaComNao) {
        return {
            match: true,
            type: 'sem_site',
            reason: 'Iniciou a resposta com negação ("Não") perante a pergunta sobre site',
            method: 'rules'
        };
    }

    // 6. Resposta sem menção conclusiva (ex: "Oi quem fala?", "Como posso ajudar?")
    return {
        match: false,
        type: 'inconclusivo',
        reason: 'Resposta sem menção conclusiva sobre presença ou ausência de site',
        method: 'rules'
    };
}

/**
 * Chamada pré-pronta para a IA Gemini (quando o usuário ativar no seletor)
 */
async function classificarComGemini(textoMensagem, geminiConfig = null) {
    const config = getConfig();
    const apiKey = geminiConfig?.apiKey || config.gemini.apiKey || process.env.GEMINI_API_KEY;
    const model = geminiConfig?.model || config.gemini.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

    if (!apiKey) {
        throw new Error('Chave GEMINI_API_KEY não configurada');
    }

    const templatePrompt = geminiConfig?.prompt || config.gemini.prompt || DEFAULT_CONFIG.gemini.prompt;
    const prompt = templatePrompt.replace('{TEXTO}', textoMensagem);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const apiRes = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
    }, { timeout: 7000 });

    const candidate = apiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
        throw new Error('Resposta vazia da API do Gemini');
    }

    const parsed = JSON.parse(candidate);
    return {
        match: Boolean(parsed.match),
        type: parsed.match ? 'sem_site' : 'com_site',
        reason: parsed.reason || (parsed.match ? 'IA confirmou ausência de site' : 'IA identificou presença de site'),
        method: 'gemini'
    };
}

/**
 * Orquestrador Geral de Classificação
 * Respeita o seletor:
 * - Se mode === 'rules': executa direto e instantaneamente (sem custos/chaves)
 * - Se mode === 'gemini': usa a API do Gemini com fallback seguro para regras
 */
async function classificarAusenciaSite(textoMensagem, logCallback = null) {
    if (!textoMensagem) return { match: false, type: 'vazio', reason: 'Mensagem vazia' };

    const config = getConfig();

    if (config.mode === 'gemini') {
        try {
            const resGemini = await classificarComGemini(textoMensagem);
            if (logCallback) {
                logCallback(`[Classificador IA Gemini] ${resGemini.match ? '🔥 Ausência confirmada' : 'ℹ️ Com site'}: ${resGemini.reason}`, 'info');
            }
            return resGemini;
        } catch (err) {
            if (logCallback) {
                logCallback(`⚠️ [Gemini IA] Falha na API (${err.message}). Utilizando motor de respostas pré-criadas como fallback seguro.`, 'warning');
            }
            // Fallback automático para regras pré-criadas
            const fallback = classificarPorRegras(textoMensagem);
            fallback.method = 'rules_fallback';
            return fallback;
        }
    }

    // Modo Padrão: Regras e Respostas Pré-Criadas (Máquina de Vendas)
    const resRegras = classificarPorRegras(textoMensagem);
    if (logCallback) {
        logCallback(`[Classificador Respostas Pré-Criadas] ${resRegras.match ? '🔥 SEM SITE' : (resRegras.type === 'com_site' ? 'ℹ️ COM SITE' : '⏳ Neutro')}: ${resRegras.reason}`, resRegras.match ? 'success' : 'info');
    }
    return resRegras;
}

/**
 * Função para testar a classificação e retornar a ação da Máquina de Vendas correspondente
 */
async function testarClassificacao(textoMensagem) {
    const config = getConfig();
    let resultado;

    if (config.mode === 'gemini') {
        try {
            resultado = await classificarComGemini(textoMensagem);
        } catch (e) {
            resultado = classificarPorRegras(textoMensagem);
            resultado.method = 'rules_fallback';
            resultado.geminiError = e.message;
        }
    } else {
        resultado = classificarPorRegras(textoMensagem);
    }

    let actionSummary = '';
    if (resultado.match) {
        actionSummary = '🔥 AÇÃO (AQUECIDO AUTOMÁTICO): O lead confirmou ausência de site. O chip comprador permanece em silêncio total. O Bot da Máquina de Vendas é agendado automaticamente após o delay configurado.';
    } else if (resultado.type === 'com_site') {
        actionSummary = 'ℹ️ AÇÃO (COM SITE / DESCARTADO): O lead possui site ou enviou link. Chip comprador em silêncio. Lead é descartado e não receberá a abordagem do Bot de Vendas.';
    } else {
        actionSummary = '🤔 AÇÃO (PENDENTE TRIAGEM MANUAL): Resposta inconclusiva ou dúvida ("quem é?", "posso ajudar?"). O chip comprador permanece em silêncio. O lead vai para a Mesa de Triagem Manual no painel para sua análise e decisão com 1 clique.';
    }

    return {
        input: textoMensagem,
        activeMode: config.mode,
        ...resultado,
        actionSummary
    };
}

module.exports = {
    getConfig,
    saveConfig,
    normalizarTexto,
    classificarPorRegras,
    classificarComGemini,
    classificarAusenciaSite,
    testarClassificacao
};
