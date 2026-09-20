/**
 * Cloudflare Pages Function — équivalent du proxy Netlify (netlify/functions/notify-discord.js)
 * mentionné dans le site. Transmet le message au vrai webhook Discord sans jamais l'exposer
 * dans le code source de la page.
 *
 * Emplacement obligatoire : /functions/api/notify-discord.js à la racine du projet déployé.
 * Route générée automatiquement : /api/notify-discord (doit correspondre à WEBHOOK_URL dans le site).
 *
 * Variable d'environnement à créer dans Cloudflare Pages (Settings > Variables and secrets,
 * en Production ET Preview) :
 *   - DISCORD_WEBHOOK_URL : l'URL de ton webhook Discord (Discord → Paramètres du salon →
 *     Intégrations → Webhooks → Créer un webhook → Copier l'URL du webhook)
 *
 * Deux formats acceptés :
 *   1) JSON (commande sans fichier) : transmis tel quel, comme avant.
 *   2) multipart/form-data (commande avec fichiers joints : payload_json + files[0], files[1]…) :
 *      les octets sont transmis sans être relus ni modifiés, avec le même Content-Type (il contient
 *      le « boundary » qui délimite les fichiers — ne jamais le recréer à la main).
 */

// Le site limite déjà les fichiers à 10 Mo au total (ORDER_FILES_MAX_BYTES dans index.html).
// Ici on garde une petite marge pour le texte de la commande. Si tu montes la limite côté site
// (serveur Discord boosté), monte aussi celle-ci.
const MAX_MULTIPART_BYTES = 11 * 1024 * 1024;

const jsonResponse = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost(context) {
  const { request, env } = context;

  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return jsonResponse({
      success: false,
      error: "Proxy mal configuré : DISCORD_WEBHOOK_URL manquant dans les variables d'environnement Cloudflare Pages."
    }, 500);
  }

  try {
    const contentType = request.headers.get('Content-Type') || '';
    const isMultipart = contentType.toLowerCase().startsWith('multipart/form-data');

    let discordResponse;
    if (isMultipart) {
      // Refuse tôt ce qui est trop gros (en-tête), puis revérifie sur les octets réellement reçus.
      const declared = Number(request.headers.get('Content-Length') || 0);
      if (declared > MAX_MULTIPART_BYTES) {
        return jsonResponse({ success: false, error: 'Fichiers trop lourds (10 Mo maximum au total).' }, 413);
      }
      const bytes = await request.arrayBuffer(); // arrayBuffer, pas text() : text() abîmerait les fichiers binaires
      if (bytes.byteLength > MAX_MULTIPART_BYTES) {
        return jsonResponse({ success: false, error: 'Fichiers trop lourds (10 Mo maximum au total).' }, 413);
      }
      discordResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': contentType }, // même valeur, boundary compris
        body: bytes
      });
    } else {
      const body = await request.text();
      discordResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
    }

    if (!discordResponse.ok) {
      const errText = await discordResponse.text();
      return jsonResponse({ success: false, error: 'Discord a refusé le message : ' + errText }, discordResponse.status);
    }

    return jsonResponse({ success: true }, 200);
  } catch (err) {
    return jsonResponse({ success: false, error: "Échec de l'appel à Discord : " + String(err) }, 502);
  }
}
