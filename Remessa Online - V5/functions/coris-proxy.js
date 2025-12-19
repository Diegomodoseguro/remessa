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
const extractCoverageValue = (planName) => {
    let match = planName.match(/(\d{2,3})\.?(\d{3})?/); 
    if (match) {
        let val = parseInt(match[0].replace('.', ''));
        if (val < 1000) val = val * 1000; 
        return val;
    }
    return 0;
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!CORIS_LOGIN || !CORIS_SENHA) return { statusCode: 500, body: JSON.stringify({ error: 'Credenciais ausentes.' }) };

    try {
        const { destination, days, ages, tripType, origin } = JSON.parse(event.body); 
        // tripType: 1=Lazer, 2=Intercambio, 3=Multiviagem, 4=Receptivo

        if (!destination || !days || !ages) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Dados incompletos' }) };
        }

        // 1. Distribuir idades nas faixas da Coris (Conforme Manual)
        // pax065: 0-65 | pax7685: 66-70 | pax86100: 71-80 | p2: 81-85 | 86+: Não comercializado
        const brackets = { pax065: 0, pax7685: 0, pax86100: 0, p2: 0 };
        
        ages.forEach(ageStr => {
            const age = parseInt(ageStr);
            if (age <= 65) brackets.pax065++;
            else if (age <= 70) brackets.pax7685++; // Manual: "passageiros de 66 a 70 anos"
            else if (age <= 80) brackets.pax86100++; // Manual: "passageiros de 71 a 80 anos"
            else if (age <= 85) brackets.p2++; // Manual: "passageiros acima dos 81 a 85 anos"
            // > 85 ignorado conforme regra de negócio
        });

        // 2. Configurar Parâmetros de Busca de Planos
        let homeVal = '0';
        let multiVal = '0';
        let destVal = destination;
        let catVal = '1'; // Default Lazer

        // Lógica de Tipo de Viagem (Manual)
        if (tripType == '3') { // Multiviagem
            homeVal = '1';
            multiVal = '0'; // Traz todos ou usar 30/60 se específico
            catVal = '3';
        } else if (tripType == '4') { // Receptivo
            homeVal = '22';
            destVal = '2'; // Manual: "destino com valor 2"
            catVal = '5';
        } else if (tripType == '2') { // Intercambio
            catVal = '2';
        }

        const planosParams = {
            'login': CORIS_LOGIN,
            'senha': CORIS_SENHA,
            'destino': destVal,
            'vigencia': days,
            'home': homeVal,
            'multi': multiVal
        };

        // Chamada BuscarPlanosNovosV13
        const planosRes = await fetch(CORIS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPlanosNovosV13' },
            body: createSoapEnvelope('BuscarPlanosNovosV13', planosParams)
        });
        
        const planosText = await planosRes.text();
        let planos = parseCorisXML(planosText, 'buscaPlanos');

        // 3. Filtragem de Planos (Regras de Negócio Remessa)
        planos = planos.filter(p => {
            const val = extractCoverageValue(p.nome);
            if (origin === 'sempre_unico') return val >= 60000 && val <= 1000000;
            if (origin === 'index') return val <= 700000;
            return true;
        });

        if (planos.length === 0) return { statusCode: 200, body: JSON.stringify([]) };

        // 4. Buscar Preços Individuais (BuscarPrecosIndividualV13)
        // Todos parâmetros declarados conforme manual
        const plansWithPrice = await Promise.all(planos.map(async (p) => {
            const precoParams = {
                'login': CORIS_LOGIN,
                'senha': CORIS_SENHA,
                'idplano': p.id,
                'dias': days,
                'pax065': brackets.pax065,
                'pax6675': '0', // Descontinuado
                'pax7685': brackets.pax7685, // 66-70 anos
                'pax86100': brackets.pax86100, // 71-80 anos
                'angola': 'N',
                'furtoelet': '0',
                'bagagens': '0',
                'morteac': '0',
                'mortenat': '0',
                'cancplus': '0',
                'cancany': '0',
                'formapagamento': '',
                'destino': destVal,
                'categoria': catVal,
                'codigodesconto': '',
                'danosmala': '0',
                'pet': '0',
                'p1': '0', // Assistencia Psicologica
                'p2': brackets.p2.toString(), // 81-85 anos (varchar)
                'p3': '0' // Quarentena Covid (0 pois FAQ diz que já é embutido)
            };

            const precoRes = await fetch(CORIS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'http://www.coris.com.br/WebService/BuscarPrecosIndividualV13' },
                body: createSoapEnvelope('BuscarPrecosIndividualV13', precoParams)
            });

            const precoText = await precoRes.text();
            const precoData = parseCorisXML(precoText, 'buscaPrecos')[0];

            if (precoData && (precoData.precoindividualrs || precoData.totalrs)) {
                // totalrs contém o valor total considerando todos os paxes e agravos
                const totalBRL = parseFloat((precoData.totalrs || precoData.precoindividualrs).replace('.', '').replace(',', '.'));
                
                const coverage = extractCoverageValue(p.nome);
                const dmh = `USD ${coverage.toLocaleString('pt-BR')}`;
                
                // Lógica de exibição de bagagem baseada no tier
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
                    tripTypeId: tripType,
                    rawPrice: precoData.totalrs 
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