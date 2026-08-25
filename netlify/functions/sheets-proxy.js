// Fonction Netlify : sert d'intermédiaire sécurisé entre le site et Google Apps Script.
// Le secret et l'URL réelle du script restent uniquement dans les variables d'environnement
// Netlify (GOOGLE_SCRIPT_URL, GOOGLE_SCRIPT_SECRET) — jamais envoyés au navigateur.

exports.handler = async (event) => {
  const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
  const GOOGLE_SCRIPT_SECRET = process.env.GOOGLE_SCRIPT_SECRET;

  if (!GOOGLE_SCRIPT_URL || !GOOGLE_SCRIPT_SECRET) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'Variables GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET manquantes sur Netlify' })
    };
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  params.set('secret', GOOGLE_SCRIPT_SECRET); // le vrai secret est injecté ici, côté serveur

  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?${params.toString()}`);
    const text = await response.text();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: text
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, error: 'Impossible de contacter Google Apps Script' })
    };
  }
};
