import { chromium } from 'playwright';

const BASE = (process.env.CREDERE_BASE_URL || 'https://m.meucredere.com.br').replace(/\/$/, '');
const RESULT_TIMEOUT = Number(process.env.RESULT_TIMEOUT_MS || 120000);

const pausa = (min, max) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

// Rótulos candidatos de cada campo do formulário (dentro do iframe do embed).
// v0: ajustar depois de rodar /discover e ver os rótulos reais.
const CAMPOS = [
  { chave: 'nome', rotulos: [/nome/i], obrigatorio: true },
  { chave: 'cpf', rotulos: [/cpf/i], obrigatorio: true },
  { chave: 'data_nascimento', rotulos: [/nascimento/i], obrigatorio: false },
  { chave: 'telefone', rotulos: [/celular|telefone/i], obrigatorio: false },
  { chave: 'email', rotulos: [/e-?mail/i], obrigatorio: false },
  { chave: 'renda', rotulos: [/renda|sal[aá]rio/i], obrigatorio: false },
  { chave: 'valor_veiculo', rotulos: [/valor do (ve[ií]culo|bem)|valor/i], obrigatorio: true },
  { chave: 'entrada', rotulos: [/entrada/i], obrigatorio: false },
];

export function mascararTexto(t) {
  return String(t || '')
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '***.***.***-**')
    .replace(/\(?\d{2}\)?\s?9?\d{4}-?\d{4}/g, '(**) *****-****');
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
  return { browser, page };
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
  const handle = await page.waitForSelector('#credere-initializer-iframe', { timeout: 30000 });
  const frame = await handle.contentFrame();
  if (!frame) throw Object.assign(new Error('frame_indisponivel'), { codigo: 'formulario_mudou' });
  await frame.waitForSelector('input, select', { timeout: 30000 });
  await pausa(800, 1500);
  return frame;
}

async function localizar(frame, rotulos) {
  for (const r of rotulos) {
    const porLabel = frame.getByLabel(r).first();
    if (await porLabel.count()) return porLabel;
    const porPlaceholder = frame.getByPlaceholder(r).first();
    if (await porPlaceholder.count()) return porPlaceholder;
  }
  return null;
}

function valorTexto(chave, dados) {
  const v = dados[chave];
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

async function preencher(frame, dados) {
  const naoEncontrados = [];
  for (const campo of CAMPOS) {
    const valor = valorTexto(campo.chave, dados);
    if (valor === null) continue;
    const el = await localizar(frame, campo.rotulos);
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

export async function simular({ conta, dados }) {
  const { browser, page } = await abrirNavegador();
  try {
    await login(page, conta);
    const frame = await abrirFormulario(page);
    const faltando = await preencher(frame, dados);
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
      .getByRole('button', { name: /simular|calcular|enviar|continuar|consultar/i })
      .first();
    if (!(await botao.count())) {
      return { status: 'erro', motivo: 'botao_nao_encontrado', campos_nao_encontrados: faltando };
    }
    await botao.click();

    // O embed avisa o portal, que redireciona para /simulations/<uuid>
    await page.waitForURL(/\/simulations\/[0-9a-f-]{8,}/i, { timeout: 60000 }).catch(() => {});
    const texto = await aguardarResultado(page);
    const { geral, bancos } = interpretar(texto);
    return {
      status: geral,
      bancos,
      campos_nao_encontrados: faltando,
      resumo: mascararTexto(texto).slice(0, 3000),
    };
  } catch (e) {
    return { status: 'erro', motivo: e.codigo || 'falha_inesperada' };
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
      return Array.from(document.querySelectorAll('input, select, textarea')).map((el) => ({
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
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .map((b) => b.innerText.trim())
        .filter(Boolean)
        .slice(0, 40),
    );
    const titulos = await frame.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,legend,label'))
        .map((e) => e.innerText.trim())
        .filter(Boolean)
        .slice(0, 80),
    );
    return { status: 'ok', campos, botoes, titulos };
  } catch (e) {
    return { status: 'erro', motivo: e.codigo || 'falha_inesperada' };
  } finally {
    await browser.close().catch(() => {});
  }
}
