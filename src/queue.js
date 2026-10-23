// Fila em memória, uma consulta por vez, com intervalo aleatório entre elas.
const MIN = Number(process.env.MIN_INTERVALO_MS || 8000);
const MAX = Number(process.env.MAX_INTERVALO_MS || 20000);

let cadeia = Promise.resolve();
let pendentes = 0;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

export function enfileirar(tarefa) {
  pendentes += 1;
  const posicao = pendentes;
  cadeia = cadeia
    .then(async () => {
      try {
        await tarefa();
      } finally {
        pendentes -= 1;
        await espera(MIN + Math.random() * Math.max(0, MAX - MIN));
      }
    })
    .catch(() => {});
  return posicao;
}

export function tamanhoFila() {
  return pendentes;
}
