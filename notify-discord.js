// Fonction Netlify : relaie les notifications (nouvelles commandes, avis...) vers Discord.
// L'URL réelle du webhook Discord reste dans la variable d'environnement Netlify
// DISCORD_WEBHOOK_URL — jamais visible dans le code du site.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Méthode non autorisée' };
  }

  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  if (!DISCORD_WEBHOOK_URL) {
    return { statusCode: 500, body: JSON.stringify({ error: 'DISCORD_WEBHOOK_URL manquante sur Netlify' }) };
  }

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body
    });
    return {
      statusCode: response.status,
      body: JSON.stringify({ ok: response.ok })
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Envoi Discord impossible' }) };
  }
};
