const fetch = require('node-fetch');

// --- CREDENCIAIS DE AMBIENTE ---
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

// Extrai valor numérico da cobertura (Ex: "60.000" -> 60000)
const extractCoverageValue = (planName, dmhDescription) => {
    // Tenta pegar do nome primeiro (Ex: CORIS 60)
    let match = planName.match(/(\d{2,3})\.?(\d{3})?/); 
    if (match) {
        let val = parseInt(match[0].replace('.', ''));
        if (val < 1000) val = val * 1000; // Ajuste para "Coris 60" -> 60000
        return val;
    }
    // Fallback para descrição
    if (dmhDescription) {
        match = dmhDescription.match(/(\d{1,3}[.,]?\d{3})/);
        if (match) return parseInt(match[0].replace(/[.,]/g, ''));
    }
    return 0;
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!CORIS_LOGIN || !CORIS_SENHA) return { statusCode: 500, body: JSON.stringify({ error: 'Credenciais ausentes.' }) };

    try {
        const { destination, days, ages, tripType, origin } = JSON.parse(event.body); // origin: 'sempre_unico' ou 'index'

        if (!destination || !days || !ages || ages.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos' }) };
        }

        // 1. Distribuir idades nas faixas da Coris
        const ageBrackets = { pax065: 0, pax070: 0, pax075: 0, pax080: 0, pax085: 0 };
        ages.forEach(age => {
            const a = parseInt(age);
            if (a <= 65) ageBrackets.pax065++;
            else if (a <= 70) ageBrackets.pax070++;
            else if (a <= 75) ageBrackets.pax075++;
            else if (a <= 80) ageBrackets.pax080++;
            else if (a <= 85) ageBrackets.pax085++;
            else ageBrackets.pax085++; // Fallback > 85
        });

        // 2. Buscar Planos Disponíveis
        // Nota: idtipoviagem pode ser passado se a API suportar, caso contrário filtramos
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
        let planos = parseCorisXML(planosText, 'buscaPlanos');

        // 3. Filtragem de Planos (Regras de Negócio)
        planos = planos.filter(p => {
            const val = extractCoverageValue(p.nome, '');
            
            // Regra Sempre Único: 60k a 1M
            if (origin === 'sempre_unico') {
                return val >= 60000 && val <= 1000000;
            }
            
            // Regra Index (Geral): Até 700k
            if (origin === 'index') {
                return val <= 700000;
            }
            
            return true;
        });

        if (planos.length === 0) return { statusCode: 200, body: JSON.stringify([]) };

        // 4. Buscar Preços (Cotação Real com Idades)
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoEnvelope = createSoapEnvelope('BuscarPrecosIndividualV13', {
                'login': CORIS_LOGIN,
                'senha': CORIS_SENHA,
                'idplano': p.id,
                'dias': days,
                'pax065': ageBrackets.pax065,
                'pax070': ageBrackets.pax070,
                'pax075': ageBrackets.pax075,
                'pax080': ageBrackets.pax080,
                'pax085': ageBrackets.pax085
            });

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPrecosIndividualV13' },
                body: precoEnvelope
            });

            const precoText = await precoRes.text();
            const precoData = parseCorisXML(precoText, 'buscaPrecos')[0];

            if (precoData && precoData.precoindividualrs) {
                const totalBRL = parseFloat(precoData.totalrs.replace(',', '.')); // Total já calculado pela Coris com todas as idades
                
                // Formatação DMH e Bagagem baseada no nome (Simulação pois a API de Preço não retorna a cobertura detalhada as vezes)
                const coverage = extractCoverageValue(p.nome);
                const dmh = `USD ${coverage.toLocaleString('pt-BR')}`;
                
                // Lógica simples de bagagem baseada no tier
                let bagagem = 'USD 1.000';
                if(coverage >= 60000) bagagem = 'USD 1.500';
                if(coverage >= 100000) bagagem = 'USD 2.000';
                if(coverage >= 250000) bagagem = 'USD 3.000';

                return {
                    id: p.id,
                    nome: p.nome,
                    dmh: dmh,
                    bagagem: bagagem,
                    originalPriceTotalBRL: totalBRL,
                    tripTypeId: tripType // Repassa para controle
                };
            }
            return null;
        }));

        const validPlans = plansWithPrice.filter(p => p !== null).sort((a, b) => a.originalPriceTotalBRL - b.originalPriceTotalBRL);

        return {
            statusCode: 200,
            body: JSON.stringify(validPlans)
        };

    } catch (error) {
        console.error('Erro Proxy Coris:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};