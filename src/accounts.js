// Contas da Credere por loja. Vêm só de variável de ambiente (CREDERE_ACCOUNTS).
// Nunca logar login/senha.

let cache = null;

function carregar() {
  if (cache) return cache;
  try {
    cache = JSON.parse(process.env.CREDERE_ACCOUNTS || '{}');
  } catch {
    console.error('[contas] CREDERE_ACCOUNTS não é um JSON válido');
    cache = {};
  }
  return cache;
}

export function listarLojas() {
  return Object.keys(carregar());
}

export function contaDaLoja(slug) {
  const contas = carregar();
  const c = contas[slug] || contas.default;
  if (!c || !c.login || !c.senha) return null;
  return { login: c.login, senha: c.senha };
}
