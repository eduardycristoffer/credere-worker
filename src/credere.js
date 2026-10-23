import { chromium } from 'playwright';

const BASE = (process.env.CREDERE_BASE_URL || 'https://m.meucredere.com.br').replace(/\/$/, '');
const RESULT_TIMEOUT = Number(process.env.RESULT_TIMEOUT_MS || 120000);

const pausa = (min, max) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

// Campos do formulário "Nova simulação". Os de seletor fixo foram confirmados no HTML real
// (lead[cpf_cnpj], lead[name], lead[phone_number]). Os demais usam rótulo estimado e são
// opcionais: se não existirem, aparecem em campos_nao_encontrados.
// Loja, vendedor e placa ficam como estão (fixos / ignorados).
const CAMPOS = [
  { chave: 'cpf', seletores: ['input[name="lead[cpf_cnpj]"]'], obrigatorio: true },
  { chave: 'nome', seletores: ['input[name="lead[name]"]'], obrigatorio: true },
  { chave: 'telefone', seletores: ['input[name="lead[phone_number]"]'], obrigatorio: true },
  {
    chave: 'valor_veiculo',
    seletores: ['input[name*="asset_value"]', 'input[name*="[value]"]'],
    rotulos: [/valor d[oa] (ve[ií]culo|bem|moto)/i],
    obrigatorio: false,
    moeda: true,
  },
  { chave: 'entrada', seletores: ['input[name*="down_payment"]', 'input[name*="entry"]'], rotulos: [/entrada/i], obrigatorio: false, moeda: true },
  { chave: 'data_nascimento', seletores: ['input[name*="birth"]'], rotulos: [/nascimento/i], obrigatorio: true },
  { chave: 'email', seletores: ['input[name="lead[email]"]'], rotulos: [/e-?mail/i], obrigatorio: true },
  { chave: 'renda', seletores: ['input[name*="income"]'], rotulos: [/renda|sal[aá]rio/i], obrigatorio: false, moeda: true },
];

const CAMPO_VEICULO = 'simulation[vehicle][name]';

export function mascararTexto(t) {
  return String(t || '')
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '***.***.***-**')
    .replace(/\(?\d{2}\)?\s?9?\d{4}-?\d{4}/g, '(**) *****-****');
}

// Só a primeira linha do erro (sem o "call log" do Playwright), para diagnóstico.
function detalheErro(e) {
  return String(e?.message || e).split('\n')[0].slice(0, 300);
}

async function abrirNavegador() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Registro leve para diagnóstico (só host/caminho, sem parâmetros e sem dados de cliente)
  const logs = { console: [], falhas: [] };
  const hp = (u) => {
    try {
      const x = new URL(u);
      return x.host + x.pathname;
    } catch {
      return String(u).slice(0, 60);
    }
  };
  page.__logs = logs;
  page.on('console', (m) => {
    if (m.type() === 'error' && logs.console.length < 8) logs.console.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => {
    if (logs.console.length < 8) logs.console.push(`pageerror: ${String(e.message).slice(0, 160)}`);
  });
  page.on('requestfailed', (r) => {
    if (logs.falhas.length < 10) logs.falhas.push(`${hp(r.url())} ${r.failure()?.errorText || ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && logs.falhas.length < 10) logs.falhas.push(`${r.status()} ${hp(r.url())}`);
  });
  return { browser, page };
}

async function diagnostico(page) {
  const d = { logs: page.__logs };
  try {
    d.frames = page.frames().map((f) => {
      try {
        const x = new URL(f.url());
        return x.host + x.pathname;
      } catch {
        return String(f.url()).slice(0, 60);
      }
    });
  } catch {
    /* sem frames */
  }
  try {
    d.embed = await page.evaluate(() => {
      const e = document.querySelector('#credere-embed-app');
      if (!e) return null;
      return {
        filhos: e.children.length,
        inputs: e.querySelectorAll('input,select').length,
        iframes: e.querySelectorAll('iframe').length,
        texto: (e.innerText || '').slice(0, 300),
      };
    });
  } catch {
    /* página fechada */
  }
  return d;
}

async function login(page, conta) {
  await page.goto(`${BASE}/d/users/sign_in`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[type="email"], input[name="user[email]"], input[name*="login"]').first();
  const senha = page.locator('input[type="password"]').first();
  await email.waitFor({ state: 'visible' });
  await email.click();
  await email.pressSequentially(conta.login, { delay: 40 + Math.random() * 50 });
  await pausa(300, 700);
  await senha.click();
  await senha.pressSequentially(conta.senha, { delay: 40 + Math.random() * 50 });
  await pausa(300, 700);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('button[type="submit"], input[type="submit"]').first().click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  if (/sign_in|\/users\/login/.test(page.url())) {
    const err = new Error('login_falhou');
    err.codigo = 'login_falhou';
    throw err;
  }
}

async function abrirFormulario(page) {
  await page.goto(`${BASE}/simulations/new`, { waitUntil: 'domcontentloaded' });
  // O formulário é um app embutido em #credere-embed-app: renderiza direto na página
  // (ou, em outras versões, dentro de um iframe). Os dois casos são tratados.
  await page.waitForSelector('#credere-embed-app', { timeout: 30000 });
  // O app embutido pode criar um iframe depois do load, ou renderizar direto na página.
  const limite = Date.now() + 60000;
  let alvo = null;
  while (!alvo && Date.now() < limite) {
    const filho = page.frames().find((f) => f !== page.mainFrame() && /meucredere/.test(f.url()));
    try {
      if (filho && (await filho.locator('input[name="lead[cpf_cnpj]"]').count())) alvo = filho;
    } catch {
      /* frame ainda carregando */
    }
    if (!alvo && (await page.locator('input[name="lead[cpf_cnpj]"]').count())) {
      alvo = page;
    }
    if (!alvo) await page.waitForTimeout(1000);
  }
  if (!alvo) {
    throw Object.assign(new Error('formulario_nao_carregou'), { codigo: 'formulario_mudou' });
  }
  await pausa(800, 1500);
  return alvo;
}

async function localizar(frame, campo) {
  for (const s of campo.seletores || []) {
    const el = frame.locator(s).first();
    if (await el.count()) return el;
  }
  for (const r of campo.rotulos || []) {
    const porLabel = frame.getByLabel(r).first();
    if (await porLabel.count()) return porLabel;
    const porPlaceholder = frame.getByPlaceholder(r).first();
    if (await porPlaceholder.count()) return porPlaceholder;
  }
  return null;
}

function valorTexto(campo, dados) {
  const v = dados[campo.chave];
  if (v === undefined || v === null || v === '') return null;
  if (campo.moeda && typeof v === 'number') {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(v);
}

async function preencher(frame, dados) {
  const naoEncontrados = [];
  for (const campo of CAMPOS) {
    const valor = valorTexto(campo, dados);
    if (valor === null) continue;
    const el = await localizar(frame, campo);
    if (!el) {
      naoEncontrados.push(campo.chave);
      continue;
    }
    await el.click();
    await el.fill('');
    await el.pressSequentially(valor, { delay: 30 + Math.random() * 60 });
    await el.blur().catch(() => {});
    await pausa(250, 700);
  }
  return naoEncontrados;
}

const normaliza = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "JET 125" -> "SHINERAY - JET 125"; "SHI 175s EFI" -> "SHINERAY - SHI" (maior nome contido).
export function escolherOpcaoVeiculo(opcoes, modelo) {
  const alvo = normaliza(modelo);
  if (!alvo) return null;
  const lista = opcoes.map((v) => ({ v, n: normaliza(v.replace(/^\s*SHINERAY\s*-\s*/i, '')) }));
  const exato = lista.find((o) => o.n === alvo);
  if (exato) return exato.v;
  const contidos = lista
    .filter((o) => o.n && ` ${alvo} `.includes(` ${o.n} `))
    .sort((a, b) => b.n.length - a.n.length);
  return contidos.length ? contidos[0].v : null;
}

async function selecionarVeiculo(frame, modelo) {
  const gatilho = frame
    .locator(`div.credere-form-field-input:has(input[name="${CAMPO_VEICULO}"])`)
    .first();
  await gatilho.waitFor({ state: 'visible' });
  const opcoes = await frame
    .locator(`input[name="${CAMPO_VEICULO}"]`)
    .evaluateAll((els) => els.map((e) => e.value));
  const escolhida = escolherOpcaoVeiculo(opcoes, modelo);
  if (!escolhida) {
    throw Object.assign(new Error('veiculo_nao_encontrado'), { codigo: 'veiculo_nao_encontrado' });
  }
  await gatilho.click({ position: { x: 24, y: 14 } });
  await pausa(300, 600);
  const opcao = gatilho
    .locator(`label.credere-form-field-sublabel:has(input[value="${escolhida}"])`)
    .first();
  await opcao.scrollIntoViewIfNeeded().catch(() => {});
  await opcao.click({ timeout: 15000 });
  await pausa(1200, 2200); // o formulário pode abrir campos novos depois da escolha
  return escolhida;
}

// ---- Campos do veículo que dependem da escolha (anos, modelo, novo, uso comercial) ----

function campoPorLegenda(frame, regex) {
  return frame
    .locator('fieldset.credere-form-field')
    .filter({ has: frame.locator('.credere-form-field-legend', { hasText: regex }) })
    .first();
}

async function opcoesDoSelect(fs) {
  return fs
    .locator('input.credere-form-field-subinput')
    .evaluateAll((els) => els.map((e) => e.getAttribute('value-label') || e.value));
}

async function escolherOpcao(fs, texto) {
  const gatilho = fs.locator('div.credere-form-field-input').first();
  await gatilho.click({ position: { x: 24, y: 14 } });
  await pausa(300, 600);
  const alvo = String(texto).replace(/"/g, '\\"');
  const opcao = fs
    .locator(`label.credere-form-field-sublabel:has(input[value-label="${alvo}"])`)
    .first();
  await opcao.scrollIntoViewIfNeeded().catch(() => {});
  await opcao.click({ timeout: 15000 });
  await pausa(600, 1200);
}

// Espera as opções carregarem (o modelo só aparece depois de escolher os anos).
async function aguardarOpcoes(fs, ms = 15000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const o = await opcoesDoSelect(fs).catch(() => []);
    if (o.length) return o;
    await pausa(500, 800);
  }
  return [];
}

function anoDesejado(opcoes, desejado) {
  const nums = opcoes.map((o) => Number(String(o).replace(/\D/g, ''))).filter(Boolean);
  if (!nums.length) return null;
  const exato = opcoes.find((o) => Number(String(o).replace(/\D/g, '')) === desejado);
  if (exato) return exato;
  const maior = Math.max(...nums);
  return opcoes.find((o) => Number(String(o).replace(/\D/g, '')) === maior);
}

function melhorModelo(opcoes, modelo) {
  const alvo = new Set(normaliza(modelo).split(' ').filter(Boolean));
  let melhor = null;
  let pontos = -1;
  for (const o of opcoes) {
    const toks = normaliza(o).split(' ').filter(Boolean);
    const p = toks.filter((t) => alvo.has(t)).length;
    if (p > pontos) {
      pontos = p;
      melhor = o;
    }
  }
  return melhor || opcoes[0] || null;
}

async function marcarSimNao(frame, regex, sim) {
  const fs = campoPorLegenda(frame, regex);
  if (!(await fs.count())) return false;
  await fs.getByText(sim ? 'Sim' : 'Não', { exact: true }).first().click();
  await pausa(400, 900);
  return true;
}

async function preencherVeiculo(frame, dados) {
  const feito = {};
  const anoAtual = new Date().getFullYear();
  const anoFab = Number(dados.ano_fabricacao) || anoAtual;
  const anoMod = Number(dados.ano_modelo) || anoFab;

  const fsFab = campoPorLegenda(frame, /Ano de fabrica/i);
  if (await fsFab.count()) {
    const op = anoDesejado(await aguardarOpcoes(fsFab, 8000), anoFab);
    if (op) {
      await escolherOpcao(fsFab, op);
      feito.ano_fabricacao = op;
    }
  }
  const fsMod = campoPorLegenda(frame, /Ano do modelo/i);
  if (await fsMod.count()) {
    const op = anoDesejado(await aguardarOpcoes(fsMod, 8000), anoMod);
    if (op) {
      await escolherOpcao(fsMod, op);
      feito.ano_modelo = op;
    }
  }
  const fsModelo = campoPorLegenda(frame, /Modelo do ve/i);
  if (await fsModelo.count()) {
    const op = melhorModelo(await aguardarOpcoes(fsModelo, 20000), dados.modelo);
    if (op) {
      await escolherOpcao(fsModelo, op);
      feito.modelo_do_veiculo = op;
    }
  }
  feito.veiculo_novo = await marcarSimNao(frame, /Ve[ií]culo novo/i, dados.zero_km !== false);
  feito.uso_comercial = await marcarSimNao(frame, /uso comercial/i, false);
  return feito;
}

// "1990-05-17" ou "17/05/1990" ou "17051990" -> "17/05/1990" (null se não der para entender)
export function formatarData(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{2})\D?(\d{2})\D?(\d{4})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return null;
}

// Campos que a Credere exige para enviar e que o lead precisa trazer.
export function dadosFaltando(dados) {
  const f = [];
  if (!dados.cpf) f.push('cpf');
  if (!dados.nome) f.push('nome');
  if (!dados.telefone) f.push('telefone');
  if (!dados.data_nascimento) f.push('data_nascimento');
  if (!dados.email) f.push('email');
  return f;
}

async function preencherCliente(frame, dados) {
  // A Credere pergunta se o cliente tem CNH; por padrão "Sim" (pode vir carteira_motorista:false).
  return {
    carteira_motorista: await marcarSimNao(frame, /Carteira de motorista/i, dados.carteira_motorista !== false),
  };
}

// Foto do estado do formulário: cada campo, se está preenchido e se há mensagem de erro.
async function estadoFormulario(frame) {
  return frame.locator('fieldset.credere-form-field').evaluateAll((fs) =>
    fs.map((f) => {
      const legenda = (f.querySelector('.credere-form-field-legend')?.innerText || '')
        .replace(/\*/g, '')
        .trim()
        .slice(0, 50);
      const ehSelect = !!f.querySelector('.credere-form-field-select');
      const texto = ehSelect
        ? (f.querySelector('.credere-form-field-input')?.innerText || '').trim().slice(0, 60)
        : null;
      const input = f.querySelector('input:not([type=radio])');
      const erro = (f.querySelector('.credere-form-field-invalidation')?.innerText || '').trim();
      return {
        campo: legenda,
        valor: ehSelect ? texto : input ? (input.value ? 'preenchido' : 'vazio') : 'opção',
        erro: erro || undefined,
      };
    }),
  );
}

async function textoDeTodosFrames(page) {
  const partes = [];
  for (const f of page.frames()) {
    try {
      partes.push(await f.evaluate(() => document.body?.innerText || ''));
    } catch {
      /* frame fechado */
    }
  }
  return partes.join('\n');
}

const BANCOS = [
  'Banco PAN', 'PAN', 'Bradesco', 'Santander', 'Itaú', 'Itau', 'BV', 'Omni', 'Safra',
  'Banco do Brasil', 'Facta', 'Creditas', 'Honda', 'Yamaha', 'Daycoval', 'Mercantil', 'Sicredi',
];

function interpretar(texto) {
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  const bancos = [];
  linhas.forEach((l, i) => {
    const banco = BANCOS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(l));
    if (!banco) return;
    const contexto = [l, linhas[i + 1] || '', linhas[i + 2] || ''].join(' | ');
    let status = 'indefinido';
    if (/aprovad|pr[eé]-?aprovad/i.test(contexto)) status = 'aprovado';
    else if (/recusad|negad|reprovad|n[aã]o aprovad/i.test(contexto)) status = 'recusado';
    else if (/an[aá]lise|pendente|aguardando/i.test(contexto)) status = 'em_analise';
    bancos.push({ banco, status, trecho: mascararTexto(contexto).slice(0, 240) });
  });
  const aprovado = bancos.some((b) => b.status === 'aprovado');
  const todosRecusados = bancos.length > 0 && bancos.every((b) => b.status === 'recusado');
  const geral = aprovado ? 'com_proposta' : todosRecusados ? 'sem_proposta' : 'indefinido';
  return { geral, bancos };
}

async function aguardarResultado(page) {
  const limite = Date.now() + RESULT_TIMEOUT;
  let ultimo = '';
  let estavel = 0;
  while (Date.now() < limite) {
    await page.waitForTimeout(4000);
    const t = await textoDeTodosFrames(page);
    const processando = /processando|consultando|aguarde|carregando/i.test(t);
    if (t === ultimo && !processando) {
      estavel += 1;
      if (estavel >= 2) return t;
    } else {
      estavel = 0;
    }
    ultimo = t;
  }
  return ultimo;
}

// dryRun: preenche o formulário e confere os campos, mas NÃO envia a simulação.
export async function simular({ conta, dados: dadosBrutos, dryRun = false }) {
  const dados = { ...dadosBrutos, data_nascimento: formatarData(dadosBrutos.data_nascimento) };
  if (!dryRun) {
    const falta = dadosFaltando(dados);
    if (falta.length) return { status: 'erro', motivo: 'dados_incompletos', campos_faltando: falta };
  }
  const { browser, page } = await abrirNavegador();
  try {
    await login(page, conta);
    const frame = await abrirFormulario(page);
    const veiculo = await selecionarVeiculo(frame, dados.modelo);
    const detalhesVeiculo = await preencherVeiculo(frame, dados);
    const faltando = await preencher(frame, dados);
    Object.assign(detalhesVeiculo, await preencherCliente(frame, dados));
    const obrigatoriosFaltando = CAMPOS.filter(
      (c) => c.obrigatorio && faltando.includes(c.chave),
    ).map((c) => c.chave);
    if (obrigatoriosFaltando.length) {
      return {
        status: 'erro',
        motivo: 'formulario_mudou',
        campos_nao_encontrados: faltando,
      };
    }

    const botao = frame
      .getByRole('button', { name: /fazer simula[cç][aã]o|simular/i })
      .first();
    const temBotao = (await botao.count()) > 0;

    if (dryRun) {
      const lidos = {};
      for (const campo of CAMPOS) {
        const el = await localizar(frame, campo);
        lidos[campo.chave] = el
          ? campo.chave === 'cpf' || campo.chave === 'telefone'
            ? `${(await el.inputValue()).length} caracteres`
            : await el.inputValue()
          : null;
      }
      const botoes = await frame
        .locator('button, [role="button"]')
        .evaluateAll((bs) => bs.map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 15));
      return {
        status: 'preenchido',
        veiculo_escolhido: veiculo,
        veiculo_detalhes: detalhesVeiculo,
        formulario: await estadoFormulario(frame),
        campos_lidos: lidos,
        campos_nao_encontrados: faltando,
        botao_enviar_encontrado: temBotao,
        botoes,
      };
    }

    if (!temBotao) {
      return { status: 'erro', motivo: 'botao_nao_encontrado', campos_nao_encontrados: faltando };
    }
    await botao.click();

    // O embed avisa o portal, que redireciona para /simulations/<uuid>
    await page.waitForURL(/\/simulations\/[0-9a-f-]{8,}/i, { timeout: 60000 }).catch(() => {});
    if (/\/simulations\/new/.test(new URL(page.url()).pathname)) {
      // Continua no formulário: a Credere recusou o envio. Devolve os campos com erro.
      const estado = await estadoFormulario(frame).catch(() => []);
      return {
        status: 'erro',
        motivo: 'formulario_invalido',
        campos_com_erro: estado.filter((c) => c.erro).map((c) => ({ campo: c.campo, erro: c.erro })),
      };
    }
    const texto = await aguardarResultado(page);
    const { geral, bancos } = interpretar(texto);
    return {
      status: geral,
      bancos,
      campos_nao_encontrados: faltando,
      resumo: mascararTexto(texto).slice(0, 3000),
    };
  } catch (e) {
    console.error(`[simular] erro: ${detalheErro(e)}`);
    const r = { status: 'erro', motivo: e.codigo || 'falha_inesperada' };
    if (dryRun) {
      r.detalhe = detalheErro(e);
      r.diag = await diagnostico(page).catch(() => null);
    }
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Lista os campos do formulário (sem valores) para ajustarmos os rótulos.
export async function descobrir({ conta }) {
  const { browser, page } = await abrirNavegador();
  try {
    await login(page, conta);
    const frame = await abrirFormulario(page);
    const campos = await frame.evaluate(() => {
      const rotuloDe = (el) => {
        if (el.id) {
          const l = document.querySelector(`label[for="${el.id}"]`);
          if (l) return l.innerText.trim();
        }
        const pai = el.closest('label');
        return pai ? pai.innerText.trim() : null;
      };
      const raiz = document.querySelector('#credere-embed-app') || document;
      return Array.from(raiz.querySelectorAll('input, select, textarea')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        aria: el.getAttribute('aria-label'),
        rotulo: rotuloDe(el),
        opcoes: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.text).slice(0, 30) : undefined,
      }));
    });
    const botoes = await frame.evaluate(() =>
      Array.from((document.querySelector('#credere-embed-app') || document).querySelectorAll('button, [role="button"]'))
        .map((b) => b.innerText.trim())
        .filter(Boolean)
        .slice(0, 40),
    );
    const titulos = await frame.evaluate(() =>
      Array.from((document.querySelector('#credere-embed-app') || document).querySelectorAll('h1,h2,h3,legend,label'))
        .map((e) => e.innerText.trim())
        .filter(Boolean)
        .slice(0, 80),
    );
    return { status: 'ok', campos, botoes, titulos };
  } catch (e) {
    console.error(`[discover] erro: ${detalheErro(e)}`);
    // Na descoberta não há dado de cliente, então o detalhe técnico pode voltar.
    let pagina = null;
    try {
      pagina = new URL(page.url()).pathname; // só o caminho, sem parâmetros
    } catch {
      /* sem página */
    }
    const diag = await diagnostico(page).catch(() => null);
    return { status: 'erro', motivo: e.codigo || 'falha_inesperada', detalhe: detalheErro(e), pagina, diag };
  } finally {
    await browser.close().catch(() => {});
  }
}
