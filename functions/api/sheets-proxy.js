/**
 * Cloudflare Pages Function — intermédiaire entre le site et Google Apps Script.
 *   - le vrai secret et l'URL Apps Script restent dans des variables d'environnement
 *     Cloudflare (jamais dans le HTML public) ;
 *   - toute valeur "secret" envoyée par le navigateur est ignorée et remplacée par la vraie.
 *
 * Emplacement obligatoire : /functions/api/sheets-proxy.js à la racine du projet déployé sur
 * Cloudflare Pages (le dossier functions/ doit être publié À CÔTÉ de index.html).
 * Route : /api/sheets-proxy (doit correspondre à APPS_SCRIPT_URL dans le site).
 *
 * Variables d'environnement (Cloudflare Pages > Settings > Variables and Secrets,
 * en Production ET Preview — puis REDÉPLOYER, sinon elles ne sont pas prises en compte) :
 *   - GOOGLE_SCRIPT_URL    : URL du déploiement Apps Script, qui finit par /exec
 *   - GOOGLE_SCRIPT_SECRET : exactement la même valeur que SECRET dans le .gs
 *
 * CORRECTIONS par rapport à l'ancienne version :
 *   1) les requêtes POST sont maintenant gérées (envoi de fichiers clients, essai gratuit,
 *      sauvegarde Drive) : avant, elles n'arrivaient jamais jusqu'à Apps Script ;
 *   2) si Google renvoie une page HTML (déploiement non public, mauvaise URL), le site reçoit
 *      un message d'erreur clair en JSON au lieu d'une page illisible ;
 *   3) test de santé : /api/sheets-proxy?action=_health indique si les variables sont
 *      présentes, sans appeler Google et sans jamais afficher leurs valeurs.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: JSON_HEADERS });
}

function config(env) {
  const scriptUrl = env.GOOGLE_SCRIPT_URL;
  const secret = env.GOOGLE_SCRIPT_SECRET;
  if (!scriptUrl || !secret) {
    return {
      error: jsonResponse({
        success: false,
        error: "Proxy mal configuré : " +
          [!scriptUrl ? 'GOOGLE_SCRIPT_URL' : null, !secret ? 'GOOGLE_SCRIPT_SECRET' : null].filter(Boolean).join(' et ') +
          " manquant(e) dans les variables Cloudflare Pages (Production ET Preview), puis redéploie."
      }, 500)
    };
  }
  return { scriptUrl, secret };
}

// Transmet la réponse d'Apps Script ; si ce n'est pas du JSON (page HTML de Google), renvoie une erreur lisible.
async function relay(googleResponse) {
  const body = await googleResponse.text();
  const head = body.trim().slice(0, 1);
  if (head !== '{' && head !== '[') {
    return jsonResponse({
      success: false,
      error: "Apps Script a renvoyé une page HTML au lieu de JSON (HTTP " + googleResponse.status + "). " +
        "Vérifie : déploiement de type « Application Web », accès « Tout le monde », " +
        "GOOGLE_SCRIPT_URL se terminant par /exec, et qu'une « Nouvelle version » a été déployée."
    }, 502);
  }
  return new Response(body, { status: googleResponse.status, headers: JSON_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const incomingUrl = new URL(request.url);

  // Test de santé : ne contacte pas Google, ne révèle aucune valeur.
  if (incomingUrl.searchParams.get('action') === '_health') {
    return jsonResponse({
      success: true,
      proxy: 'ok',
      GOOGLE_SCRIPT_URL: !!env.GOOGLE_SCRIPT_URL,
      GOOGLE_SCRIPT_SECRET: !!env.GOOGLE_SCRIPT_SECRET,
      urlSeTermineParExec: /\/exec$/.test(String(env.GOOGLE_SCRIPT_URL || '').split('?')[0])
    });
  }

  // Auto-diagnostic : teste chaque maillon (variables, Apps Script, secret, action « list ») et dit où ça casse.
  // Ne renvoie aucune donnée de commande ni aucune valeur secrète. À retirer une fois le problème réglé.
  if (incomingUrl.searchParams.get('action') === '_selftest') {
    const cfg0 = config(env);
    if (cfg0.error) return cfg0.error;
    const probe = async (action) => {
      const u = new URL(cfg0.scriptUrl); u.searchParams.set('action', action); u.searchParams.set('secret', cfg0.secret);
      try {
        const r = await fetch(u.toString(), { redirect: 'follow' }); const t = await r.text(); let j = null;
        try { j = JSON.parse(t); } catch (e) { /* pas du JSON */ }
        return { http: r.status, json: j !== null, pageHtml: t.trim().slice(0, 1) === '<',
          success: j && !Array.isArray(j) ? j.success : undefined,
          erreurApps: j && !Array.isArray(j) && j.error ? String(j.error).slice(0, 140) : undefined,
          lignesRenvoyees: Array.isArray(j) ? j.length : undefined };
      } catch (e) { return { reseau: String(e).slice(0, 140) }; }
    };
    const getStatus = await probe('getStatus'), list = await probe('list');
    let diagnostic = 'Tout répond correctement.';
    const bad = (x) => x.reseau || x.pageHtml || !x.json || x.success === false;
    if (getStatus.pageHtml || list.pageHtml) diagnostic = "Google renvoie une page HTML : déploiement Apps Script non public (« Tout le monde »), URL qui ne finit pas par /exec, ou nouvelle version non déployée.";
    else if (/non autoris/i.test(getStatus.erreurApps || list.erreurApps || '')) diagnostic = "Apps Script refuse le secret : GOOGLE_SCRIPT_SECRET (Cloudflare) doit être identique à SECRET dans le script.";
    else if (/inconnue/i.test(getStatus.erreurApps || '')) diagnostic = "getStatus est inconnu : le bloc AJOUTS n'est pas branché dans doGet, ou aucune « Nouvelle version » n'a été déployée.";
    else if (bad(getStatus)) diagnostic = "Apps Script ne répond pas correctement à getStatus (voir détails).";
    else if (bad(list) || list.lignesRenvoyees === undefined) diagnostic = "Le script répond, mais l'action « list » ne renvoie pas un tableau de commandes : c'est elle (doGet principal) qui est en cause (voir détails).";
    else if (list.lignesRenvoyees <= 1) diagnostic = "Tout répond, mais l'onglet des commandes est vide (en-tête seul) : les commandes ne sont pas écrites par « update » (voir ORDERS_SHEET_NAME et le doGet principal).";
    return jsonResponse({ success: true, diagnostic, variables: { GOOGLE_SCRIPT_URL: true, GOOGLE_SCRIPT_SECRET: true }, getStatus, list });
  }

  const cfg = config(env);
  if (cfg.error) return cfg.error;

  const target = new URL(cfg.scriptUrl);
  incomingUrl.searchParams.forEach((value, key) => {
    if (key === 'secret') return; // jamais celui envoyé par le navigateur
    target.searchParams.set(key, value);
  });
  target.searchParams.set('secret', cfg.secret); // le vrai secret, côté serveur uniquement

  try {
    return await relay(await fetch(target.toString(), { redirect: 'follow' }));
  } catch (err) {
    return jsonResponse({ success: false, error: "Échec de l'appel à Apps Script : " + String(err) }, 502);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cfg = config(env);
  if (cfg.error) return cfg.error;

  const incomingUrl = new URL(request.url);
  const target = new URL(cfg.scriptUrl);
  incomingUrl.searchParams.forEach((value, key) => {
    if (key === 'secret') return;
    target.searchParams.set(key, value);
  });
  target.searchParams.set('secret', cfg.secret); // lu par Apps Script dans e.parameter.secret

  const contentType = request.headers.get('Content-Type') || 'text/plain;charset=utf-8';
  let body = await request.arrayBuffer();

  // Corps JSON (envoi de fichiers, sauvegarde) : le champ "secret" du corps est aussi remplacé par le vrai.
  if (/json|text\/plain/i.test(contentType)) {
    try {
      const obj = JSON.parse(new TextDecoder().decode(body));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj.secret = cfg.secret;
        body = new TextEncoder().encode(JSON.stringify(obj));
      }
    } catch (e) { /* pas du JSON : on transmet tel quel */ }
  }
  // multipart et formulaire classique : transmis tels quels, le secret passe par l'URL.

  try {
    return await relay(await fetch(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body,
      redirect: 'follow'
    }));
  } catch (err) {
    return jsonResponse({ success: false, error: "Échec de l'appel à Apps Script : " + String(err) }, 502);
  }
}
