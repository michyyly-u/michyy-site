/**
 * Cloudflare Pages Function — équivalent du proxy Netlify (netlify/functions/sheets-proxy.js)
 * mentionné dans le site. Sert d'intermédiaire entre le site et Google Apps Script :
 *   - le vrai secret et l'URL Apps Script restent dans des variables d'environnement
 *     Cloudflare (jamais dans le HTML public) ;
 *   - toute valeur "secret" envoyée par le navigateur est ignorée et remplacée par la vraie.
 *
 * Emplacement obligatoire : /functions/api/sheets-proxy.js à la racine du projet déployé sur
 * Cloudflare Pages (le dossier functions/ est déployé automatiquement à côté du site).
 * Route générée automatiquement : /api/sheets-proxy (doit correspondre à APPS_SCRIPT_URL
 * dans le site).
 *
 * Variables d'environnement à créer dans Cloudflare Pages (Settings > Environment variables,
 * en Production ET Preview) :
 *   - GOOGLE_SCRIPT_URL    : l'URL de ton déploiement Apps Script (celle qui finit par /exec)
 *   - GOOGLE_SCRIPT_SECRET : le même secret que celui vérifié côté Apps Script (SECRET dans le .gs)
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  const scriptUrl = env.GOOGLE_SCRIPT_URL;
  const secret = env.GOOGLE_SCRIPT_SECRET;

  if (!scriptUrl || !secret) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Proxy mal configuré : GOOGLE_SCRIPT_URL et/ou GOOGLE_SCRIPT_SECRET manquants dans les variables d'environnement Cloudflare Pages."
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const incomingUrl = new URL(request.url);
  const target = new URL(scriptUrl);

  // Recopie tous les paramètres envoyés par le site (action, orderId, score, comment...)
  incomingUrl.searchParams.forEach((value, key) => {
    if (key === 'secret') return; // jamais celui envoyé par le navigateur
    target.searchParams.set(key, value);
  });

  // Le vrai secret est ajouté ici, côté serveur uniquement
  target.searchParams.set('secret', secret);

  try {
    const googleResponse = await fetch(target.toString(), { redirect: 'follow' });
    const body = await googleResponse.text();

    return new Response(body, {
      status: googleResponse.status,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: 'Échec de l\'appel à Apps Script : ' + String(err) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
