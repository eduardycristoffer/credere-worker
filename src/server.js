import crypto from 'node:crypto';
import express from 'express';
import { listarLojas, contaDaLoja } from './accounts.js';
import { enfileirar, tamanhoFila } from './queue.js';
import { simular, descobrir } from './credere.js';
import { enviarCallback } from './callback.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const SECRET = process.env.WORKER_SECRET || '';

function autorizado(req) {
  const recebido = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(recebido);
  const b = Buffer.from(SECRET);
  return SECRET.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exigirAuth(req, res, next) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  return next();
}

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const mascCpf = (v) => `***.${soDigitos(v).slice(3, 6) || '***'}.***-**`;

app.get('/health', (_req, res) => res.json({ ok: true, fila: tamanhoFila() }));

// Lojas com conta cadastrada (só os slugs, nunca credenciais)
app.get('/lojas', exigirAuth, (_req, res) => res.json({ lojas: listarLojas() }));

// Descobre os campos do formulário da Credere (sem enviar nada)
app.post('/discover', exigirAuth, async (req, res) => {
  const conta = contaDaLoja(req.body?.loja_slug);
  if (!conta) return res.status(400).json({ erro: 'loja_sem_conta' });
  const r = await descobrir({ conta });
  return res.json(r);
});

// Teste: abre o formulário, escolhe a moto e preenche os campos, mas NÃO envia a simulação.
// Corpo: { loja_slug, lead:{nome,cpf,telefone}, veiculo:{modelo,valor}, entrada }
app.post('/testar', exigirAuth, async (req, res) => {
  const { loja_slug: lojaSlug, lead = {}, veiculo = {}, entrada } = req.body || {};
  const conta = contaDaLoja(lojaSlug);
  if (!conta) return res.status(400).json({ erro: 'loja_sem_conta' });
  const dados = {
    nome: lead.nome,
    cpf: soDigitos(lead.cpf),
    telefone: soDigitos(lead.telefone),
    modelo: veiculo.modelo,
    valor_veiculo: veiculo.valor,
    entrada,
  };
  const r = await simular({ conta, dados, dryRun: true });
  return res.json(r);
});

// Lead -> Credere. Responde 202 e devolve o resultado via callback.
app.post('/simular', exigirAuth, (req, res) => {
  const { analise_id: analiseId, loja_slug: lojaSlug, lead = {}, veiculo = {}, entrada } = req.body || {};
  if (!analiseId || !lojaSlug) return res.status(400).json({ erro: 'dados_incompletos' });

  const conta = contaDaLoja(lojaSlug);
  if (!conta) {
    enviarCallback({ analise_id: analiseId, status: 'erro', motivo: 'loja_sem_conta' });
    return res.status(202).json({ aceito: true, aviso: 'loja_sem_conta' });
  }

  const dados = {
    nome: lead.nome,
    cpf: soDigitos(lead.cpf),
    data_nascimento: lead.data_nascimento,
    telefone: soDigitos(lead.telefone),
    email: lead.email,
    renda: lead.renda,
    modelo: veiculo.modelo,
    valor_veiculo: veiculo.valor,
    entrada,
  };

  const posicao = enfileirar(async () => {
    console.log(`[simular] ${analiseId} loja=${lojaSlug} cpf=${mascCpf(dados.cpf)}`);
    const r = await simular({ conta, dados });
    console.log(`[simular] ${analiseId} -> ${r.status}${r.motivo ? ` (${r.motivo})` : ''}`);
    await enviarCallback({ analise_id: analiseId, loja_slug: lojaSlug, ...r });
  });

  return res.status(202).json({ aceito: true, posicao });
});

const porta = Number(process.env.PORT || 3000);
app.listen(porta, () => {
  console.log(`[credere-worker] ouvindo na porta ${porta}; lojas com conta: ${listarLojas().length}`);
  if (!SECRET) console.error('[credere-worker] WORKER_SECRET não definido: todas as rotas protegidas vão negar');
});
