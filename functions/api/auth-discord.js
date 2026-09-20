// Cloudflare Pages Function — callback appelé par Discord après que le visiteur a autorisé
// l'application (redirection plein écran, pas une popup : c'est comme ça qu'OAuth Discord
// fonctionne, impossible à faire en popup sans backend). Une fois le compte identifié/créé, cette
// fonction redirige vers le site avec la session dans l'URL ; le site la récupère au chargement puis
// nettoie l'URL (voir initAccountSystem() dans index.html).
//
// Configuration (Cloudflare Pages → Settings → Environment variables) :
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET = récupérés sur https://discord.com/developers/applications
//     → ton appli → OAuth2. Dans l'onglet OAuth2 de cette appli, ajoute cette Redirect URL EXACTEMENT :
//       https://michyy-portfolio.pages.dev/api/auth-discord
//   SESSION_SECRET = la même valeur que pour auth.js (déjà configurée si tu as fait Google/email avant).
// GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET : déjà configurées, réutilisées telles quelles.
//
// Tant que DISCORD_CLIENT_ID/SECRET ne sont pas définis, le bouton "Se connecter avec Discord" du
// site redirige ici puis revient sur le site avec un message d'erreur clair — rien d'autre n'est cassé.

import { signSession, callAppsScript } from './_auth-shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get('code');

  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) {
    return Response.redirect(`${origin}/?account_error=discord-not-configured`, 302);
  }
  if (!code) return Response.redirect(`${origin}/?account_error=discord-cancelled`, 302);

  try {
    const redirectUri = `${origin}/api/auth-discord`;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }).toString()
    });
    if (!tokenRes.ok) return Response.redirect(`${origin}/?account_error=discord-token-failed`, 302);
    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });
    if (!userRes.ok) return Response.redirect(`${origin}/?account_error=discord-user-failed`, 302);
    const discordUser = await userRes.json();

    const discordId = discordUser.id;
    const name = discordUser.username || 'Discord';
    const email = discordUser.email ? String(discordUser.email).toLowerCase() : '';

    let user = await callAppsScript(env, 'authFindUser', { discordId });
    if (!user.found && email) user = await callAppsScript(env, 'authFindUser', { email });
    if (!user.found) {
      const saved = await callAppsScript(env, 'authSaveUser', { email, name, discordId, passwordHash: '', passwordSalt: '', googleId: '' });
      user = { id: saved.id, email, name };
    } else if (!user.discordId) {
      await callAppsScript(env, 'authSaveUser', { id: user.id, email: user.email, name: user.name, discordId, passwordHash: user.passwordHash || '', passwordSalt: user.passwordSalt || '', googleId: user.googleId || '' });
    }

    const token = await signSession({ id: user.id, email: user.email || email, name: user.name || name, method: 'discord' }, env.SESSION_SECRET);
    return Response.redirect(`${origin}/?account_session=${encodeURIComponent(token)}`, 302);
  } catch (err) {
    return Response.redirect(`${origin}/?account_error=discord-server-error`, 302);
  }
}
