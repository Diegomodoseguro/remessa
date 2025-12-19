const fetch = require('node-fetch'); 
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURAÇÕES DE AMBIENTE ---
// ATENÇÃO: Configure estas variáveis no Painel do Netlify (Site Settings > Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use a Service Role Key para permitir updates de status sem RLS restritivo

const EZSIM_USER = process.env.EZSIM_USER;
const EZSIM_PASS = process.env.EZSIM_PASS;

const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = process.env.CORIS_LOGIN;
const CORIS_SENHA = process.env.CORIS_SENHA;

const MODOSEGURO_API_URL = 'https://portalv2.modoseguro.digital/api/ingest';
const TENANT_ID_REMESSA = 'RODQ19';
const EZSIM_API_URL = 'https://beta.ezsimconnect.com'; 
const TARGET_PLAN_NAME = 'eSIM, 2GB, 15 Days, Global, V2';

// Validação de Segurança Inicial
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERRO CRÍTICO: Variáveis de ambiente do Supabase não configuradas.");
}

// Inicializa Supabase
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- HELPER FUNCTIONS ---

const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, value] of Object.entries(params)) {
        paramString += `<param name="${key}" value="${value}" />`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://www.coris.com.br/WebService/">${paramString}</${method}></soap:Body></soap:Envelope>`;
};

const extractTagValue = (xml, tagName) => {
    const match = xml.match(new RegExp(`<${tagName}>(.*?)</${tagName}>`));
    return match ? match[1] : null;
};

// --- FLUXO CORIS ---
async function emitirCoris(leadData) {
    console.log(`[CORIS] Iniciando emissão para Lead ${leadData.leadId}...`);
    
    let listaPassageiros = '';
    leadData.passengers.forEach(p => {
        let dataNasc = p.nascimento;
        if (dataNasc.includes('/')) {
            const [d, m, y] = dataNasc.split('/');
            dataNasc = `${y}-${m}-${d}`;
        }
        listaPassageiros += `${p.nome}:${p.sobrenome}:${p.cpf}:${dataNasc}:${p.sexo}|`; 
    });
    listaPassageiros = listaPassageiros.slice(0, -1);

    const gravarParams = {
        'login': CORIS_LOGIN,
        'senha': CORIS_SENHA,
        'idplano': leadData.planId,
        'saida': leadData.dates.departure,
        'retorno': leadData.dates.return,
        'destino': leadData.destination,
        'passageiros': listaPassageiros,
        'contato': leadData.comprador.nome,
        'email': leadData.comprador.email,
        'telefone': (leadData.comprador.telefone || leadData.contactPhone).replace(/\D/g, ''),
        'pagamento': 'CARTAO' 
    };

    const gravarRes = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/GravarPedido' },
        body: createSoapEnvelope('GravarPedido', gravarParams) 
    });

    const gravarText = await gravarRes.text();
    const erro = extractTagValue(gravarText, 'erro');
    if (erro && erro !== '0') {
        throw new Error(`Coris GravarPedido Falhou: ${extractTagValue(gravarText, 'mensagem')}`);
    }

    const pedidoId = extractTagValue(gravarText, 'idpedido');
    console.log(`[CORIS] Pedido gravado: ${pedidoId}`);

    const emitirParams = { 'login': CORIS_LOGIN, 'senha': CORIS_SENHA, 'idpedido': pedidoId };
    const emitirRes = await fetch(CORIS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/EmitirPedido' },
        body: createSoapEnvelope('EmitirPedido', emitirParams)
    });

    const emitirText = await emitirRes.text();
    const erroEmissao = extractTagValue(emitirText, 'erro');
    if (erroEmissao && erroEmissao !== '0') {
        throw new Error(`Coris EmitirPedido Falhou: ${extractTagValue(emitirText, 'mensagem')}`);
    }

    const linkBilhete = extractTagValue(emitirText, 'linkbilhete') || extractTagValue(emitirText, 'url');
    const vouchers = []; 
    const voucherRegex = /<voucher>(.*?)<\/voucher>/g;
    let vMatch;
    while((vMatch = voucherRegex.exec(emitirText)) !== null) { vouchers.push(vMatch[1]); }

    return { voucher: vouchers.join(', '), link: linkBilhete, pedidoId: pedidoId };
}

// --- FLUXO EZSIM ---
async function getEzsimToken() {
    try {
        const response = await fetch(`${EZSIM_API_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EZSIM_USER, password: EZSIM_PASS })
        });
        const data = await response.json();
        return data.access_token;
    } catch (error) { return null; }
}

async function getBundleIdByName(token, planName) {
    if(!token) return null;
    try {
        const response = await fetch(`${EZSIM_API_URL}/rest/v1/price_list?select=*`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        const bundles = await response.json();
        const target = bundles.find(b => b.description === planName || b.name === planName);
        if(target) return target.id;
        const fb = bundles.find(b => (b.description && b.description.includes('Global') && b.description.includes('2GB')));
        return fb ? fb.id : null;
    } catch (e) { return null; }
}

async function issueEzsimChip(leadId) {
    try {
        const token = await getEzsimToken();
        if(!token) return { success: false, error: "Auth falhou" };
        
        const bundleId = await getBundleIdByName(token, TARGET_PLAN_NAME);
        if(!bundleId) return { success: false, error: "Plano não encontrado" };

        const cartRes = await fetch(`${EZSIM_API_URL}/rest/v1/cart`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ organization_bundle_id: bundleId, quantity: 1, reference: leadId })
        });
        if(!cartRes.ok) throw new Error("Falha carrinho");

        const orderRes = await fetch(`${EZSIM_API_URL}/rest/v1/sales_order`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify({ reference: leadId })
        });
        if(!orderRes.ok) throw new Error("Falha pedido");
        
        const orderData = await orderRes.json();
        return { success: true, data: orderData };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body, leadId;
    try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

    const { paymentMethodId, leadId: idDoLead, planId, amountBRL, comprador, passageiros, planName, dates, destination } = body;
    leadId = idDoLead;

    const updateSupabaseError = async (errorMsg) => {
        if (!leadId || !supabaseClient) return;
        try {
            await supabaseClient.from('remessaonlinesioux_leads')
                .update({ status: 'pagamento_falhou', last_error_message: `PROD_ERROR: ${errorMsg}`.substring(0, 255) }) 
                .eq('id', leadId);
        } catch(e) { console.error("Falha ao logar erro no Supabase", e); }
    };

    try {
        console.log(`[PROCESS] Iniciando pagamento para Lead ${leadId} Valor R$ ${amountBRL}`);
        const amountInCents = Math.round(amountBRL * 100);
        
        const modoSeguroPayload = {
            tenant_id: TENANT_ID_REMESSA,
            tipo: "stripe",
            cliente: comprador,
            enderecos: [comprador.endereco],
            pagamento: {
                amount_cents: amountInCents,
                currency: "brl",
                descricao: `Seguro Viagem Coris - ${planName}`,
                receipt_email: comprador.email,
                metadata: { lead_id_supabase: leadId, origem: "lp_remessa_prod", plano_id: planId },
                payment_method_id: paymentMethodId 
            },
            passageiros_extra: passageiros
        };

        const modoSeguroResponse = await fetch(`${MODOSEGURO_API_URL}?tenant_id=${TENANT_ID_REMESSA}&topic=venda_stripe&source=api_backend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(modoSeguroPayload)
        });

        const msResponseText = await modoSeguroResponse.text();
        if (!modoSeguroResponse.ok) throw new Error(`Pagamento recusado: ${msResponseText}`);

        let modoSeguroResult;
        try { modoSeguroResult = JSON.parse(msResponseText); } catch (e) { modoSeguroResult = { message: msResponseText }; }
        
        // Emissão CORIS
        let corisData = { voucher: 'ERRO_EMISSAO', link: '#' };
        try {
            corisData = await emitirCoris({ leadId, planId, destination, passengers: passageiros, comprador, contactPhone: body.contactPhone, dates });
        } catch (corisError) {
            console.error("Erro Crítico Emissão:", corisError);
            await updateSupabaseError(`PAGTO OK, EMISSAO FALHOU: ${corisError.message}`);
        }

        // Emissão Chip EZSIM
        let ezsimStatus = 'pendente'; 
        let ezsimDetails = null;
        try {
            const ezsimResult = await issueEzsimChip(leadId);
            if (ezsimResult.success) {
                ezsimStatus = 'emitido';
                ezsimDetails = JSON.stringify(ezsimResult.data);
            } else {
                ezsimStatus = 'erro_emissao';
                ezsimDetails = `Erro: ${ezsimResult.error}`;
            }
        } catch(e) {
            ezsimStatus = 'erro_emissao';
            ezsimDetails = e.message;
        }

        // Finalização
        await supabaseClient.from('remessaonlinesioux_leads')
            .update({
                status: 'venda_concluida',
                coris_voucher: corisData.voucher,
                coris_pedido_id: corisData.pedidoId,
                link_bilhete: corisData.link,
                stripe_payment_intent_id: modoSeguroResult?.stripe?.id || 'ms_processed',
                recovery_notes: `Ezsim: ${ezsimStatus}. Detalhes: ${ezsimDetails ? ezsimDetails.substring(0, 100) : ''}` 
            })
            .eq('id', leadId);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                voucherNumber: corisData.voucher,
                downloadLink: corisData.link,
                ezsimStatus: ezsimStatus
            })
        };

    } catch (error) {
        console.error(`Erro Geral:`, error.message);
        await updateSupabaseError(error.message);
        return { statusCode: 400, body: JSON.stringify({ success: false, error: error.message }) };
    }
};