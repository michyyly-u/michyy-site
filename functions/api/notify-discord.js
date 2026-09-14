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
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Proxy mal configuré : DISCORD_WEBHOOK_URL manquant dans les variables d'environnement Cloudflare Pages."
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.text();

    const discordResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (!discordResponse.ok) {
      const errText = await discordResponse.text();
      return new Response(
        JSON.stringify({ success: false, error: 'Discord a refusé le message : ' + errText }),
        { status: discordResponse.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: "Échec de l'appel à Discord : " + String(err) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
