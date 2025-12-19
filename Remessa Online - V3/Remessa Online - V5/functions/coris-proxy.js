const fetch = require('node-fetch');

// --- CREDENCIAIS DE AMBIENTE ---
// Configure estas variáveis no Netlify para proteger suas credenciais
const CORIS_URL = 'https://ws.coris.com.br/webservice2/service.asmx';
const CORIS_LOGIN = process.env.CORIS_LOGIN;
const CORIS_SENHA = process.env.CORIS_SENHA;

// Helper para montar XML SOAP
const createSoapEnvelope = (method, params) => {
    let paramString = '';
    for (const [key, value] of Object.entries(params)) {
        paramString += `<param name="${key}" value="${value}" />`;
    }
    return `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body>
        <${method} xmlns="http://www.coris.com.br/WebService/">
          ${paramString}
        </${method}>
      </soap:Body>
    </soap:Envelope>`;
};

// Parser simplificado de XML
const parseCorisXML = (xmlString, tagName) => {
    const results = [];
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g');
    let match;
    while ((match = regex.exec(xmlString)) !== null) {
        const content = match[1];
        const item = {};
        const fieldRegex = /<(\w+)>([^<]+)<\/\1>/g;
        let fieldMatch;
        while ((fieldMatch = fieldRegex.exec(content)) !== null) {
            item[fieldMatch[1]] = fieldMatch[2];
        }
        results.push(item);
    }
    return results;
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    if (!CORIS_LOGIN || !CORIS_SENHA) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Credenciais Coris não configuradas no ambiente.' }) };
    }

    try {
        const { destination, days, passengers } = JSON.parse(event.body);

        if (!destination || !days || !passengers) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos' }) };
        }

        // 1. Buscar Planos Disponíveis na Coris (Produção)
        const planosEnvelope = createSoapEnvelope('BuscarPlanosNovosV13', {
            'login': CORIS_LOGIN,
            'senha': CORIS_SENHA,
            'destino': destination,
            'vigencia': days
        });

        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPlanosNovosV13' },
            body: planosEnvelope
        });
        
        const planosText = await planosRes.text();
        const planos = parseCorisXML(planosText, 'buscaPlanos');

        // 2. Buscar Preços Reais para cada plano
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoEnvelope = createSoapEnvelope('BuscarPrecosIndividualV13', {
                'login': CORIS_LOGIN,
                'senha': CORIS_SENHA,
                'idplano': p.id,
                'dias': days,
                'pax065': passengers 
            });

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPrecosIndividualV13' },
                body: precoEnvelope
            });

            const precoText = await precoRes.text();
            const precoData = parseCorisXML(precoText, 'buscaPrecos')[0];

            if (precoData && precoData.precoindividualrs) {
                // Preço Base da Coris (para todos passageiros)
                let originalTotal = parseFloat(precoData.precoindividualrs.replace(',', '.')) * passengers;
                
                // Definição de Coberturas (Mapeamento visual)
                let dmh = 'USD 60.000';
                let bagagem = 'USD 1.000';
                
                if (p.nome.includes('30') || p.id.includes('178')) { dmh = 'USD 30.000'; bagagem = 'USD 1.000'; }
                if (p.nome.includes('60') || p.id.includes('174')) { dmh = 'USD 60.000'; bagagem = 'USD 1.500'; }
                if (p.nome.includes('100') || p.id.includes('179')) { dmh = 'USD 100.000'; bagagem = 'USD 2.000'; }

                return {
                    id: p.id,
                    nome: p.nome,
                    dmh: dmh,
                    bagagem: bagagem,
                    originalPriceForAllPassengersBRL: originalTotal
                };
            }
            return null;
        }));

        const validPlans = plansWithPrice.filter(p => p !== null);

        return {
            statusCode: 200,
            body: JSON.stringify(validPlans)
        };

    } catch (error) {
        console.error('Erro Proxy Coris:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};