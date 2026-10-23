// Devolve o resultado para o Lovable.
export async function enviarCallback(payload) {
  const url = process.env.LOVABLE_CALLBACK_URL;
  if (!url) {
    console.error('[callback] LOVABLE_CALLBACK_URL não configurada');
    return false;
  }
  for (let i = 1; i <= 3; i += 1) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LOVABLE_CALLBACK_TOKEN || ''}`,
        },
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
      console.error(`[callback] tentativa ${i}: HTTP ${r.status}`);
    } catch (e) {
      console.error(`[callback] tentativa ${i}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
  return false;
}
