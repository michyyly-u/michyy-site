// Cloudflare Pages Function — /api/auth : gère TOUTES les connexions SAUF Discord (qui a sa propre
// redirection OAuth, voir auth-discord.js). Regroupées ici : inscription/connexion par email+mot de
// passe, connexion Google, et mot de passe oublié.
//
// ⚠️ Pas de fichier auth-google.js séparé : contrairement à Discord (redirection OAuth plein écran,
// qui a besoin d'une URL de callback dédiée), Google utilise Google Identity Services côté
// navigateur — la page reçoit un idToken directement (voir handleGoogleCredential() dans
// index.html), sans jamais quitter le site, et l'envoie ici en POST { action: 'google', idToken }.
// Ce fichier le vérifie via l'endpoint public "tokeninfo" de Google (pas de librairie JWT à
// installer, cohérent avec la contrainte "aucune dépendance" du reste du site).
//
// Configuration (Cloudflare Pages → Settings → Environment variables) :
//   SESSION_SECRET     : une longue chaîne aléatoire au choix (même valeur que pour auth-discord.js
//                        — une session signée par l'un doit rester valide vérifiée par l'autre).
//   GOOGLE_CLIENT_ID   : LA MÊME valeur que celle déjà collée en dur dans index.html (variable JS
//                        GOOGLE_CLIENT_ID). Sert uniquement à vérifier que l'idToken reçu a bien été
//                        émis pour CE site — sans cette variable ici, cette vérification est
//                        sautée (moins sûr, mais rien de cassé si tu oublies de la configurer).
//   GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET : déjà configurées pour le reste du site, réutilisées
//                        telles quelles. Ce fichier a besoin de 4 actions côté Apps Script :
//                        authFindUser, authSaveUser, authForgotPassword, authResetPassword — voir
//                        le commentaire "onglet Users" dans index.html pour le code à coller.
//
// Tant que SESSION_SECRET n'est pas configuré, toute action répond { success:false, error:'not-configured' }
// et le site affiche un message clair au lieu de planter.

import { hashPassword, signSession, callAppsScript, jsonResponse } from './_auth-shared.js';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// --- Comparaison en temps constant : évite qu'un hash presque correct réponde légèrement plus vite
// qu'un hash complètement faux (timing attack sur la vérification du mot de passe). ---
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const check = await hashPassword(password, salt);
  return timingSafeEqual(check.hash, hash);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SESSION_SECRET) return jsonResponse({ success: false, error: 'not-configured' });

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ success: false, error: 'missing-fields' }); }
  const action = body && body.action;

  try {
    // --- Inscription / connexion par email + mot de passe ------------------------------------
    if (action === 'register' || action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!email || !password || (action === 'register' && !name)) return jsonResponse({ success: false, error: 'missing-fields' });
      if (!isValidEmail(email)) return jsonResponse({ success: false, error: 'invalid-email' });

      const found = await callAppsScript(env, 'authFindUser', { email });

      if (action === 'register') {
        if (password.length < 8) return jsonResponse({ success: false, error: 'weak-password' });
        if (found.found) return jsonResponse({ success: false, error: 'email-exists' });
        const { hash, salt } = await hashPassword(password);
        const saved = await callAppsScript(env, 'authSaveUser', { email, name, passwordHash: hash, passwordSalt: salt });
        const token = await signSession({ id: saved.id, email, name, method: 'email' }, env.SESSION_SECRET);
        return jsonResponse({ success: true, token, email, name });
      }

      // login
      if (!found.found || !(await verifyPassword(password, found.passwordHash, found.passwordSalt))) {
        return jsonResponse({ success: false, error: 'invalid-credentials' });
      }
      const token = await signSession({ id: found.id, email: found.email, name: found.name, method: 'email' }, env.SESSION_SECRET);
      return jsonResponse({ success: true, token, email: found.email, name: found.name });
    }

    // --- Connexion Google : idToken envoyé par Google Identity Services, vérifié auprès de Google
    // elle-même (endpoint tokeninfo) plutôt que de réimplémenter la vérification de signature JWT
    // à la main. --------------------------------------------------------------------------------
    if (action === 'google') {
      const idToken = body.idToken;
      if (!idToken) return jsonResponse({ success: false, error: 'missing-fields' });
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!infoRes.ok) return jsonResponse({ success: false, error: 'invalid-credentials' });
      const info = await infoRes.json();
      // 🔒 Vérifie que ce jeton a bien été émis POUR ce site — sinon un idToken Google valide pour
      // n'importe quelle autre appli pourrait servir à se connecter ici.
      if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) return jsonResponse({ success: false, error: 'invalid-credentials' });
      if (!info.email) return jsonResponse({ success: false, error: 'invalid-credentials' });
      const email = String(info.email).toLowerCase();
      const name = info.name || info.given_name || 'Compte Google';
      const googleId = info.sub;

      let user = await callAppsScript(env, 'authFindUser', { googleId });
      if (!user.found) user = await callAppsScript(env, 'authFindUser', { email });
      if (!user.found) {
        const saved = await callAppsScript(env, 'authSaveUser', { email, name, googleId });
        user = { id: saved.id, email, name };
      } else if (!user.googleId) {
        await callAppsScript(env, 'authSaveUser', {
          id: user.id, email: user.email, name: user.name, googleId,
          passwordHash: user.passwordHash || '', passwordSalt: user.passwordSalt || '', discordId: user.discordId || ''
        });
      }
      const token = await signSession({ id: user.id, email: user.email || email, name: user.name || name, method: 'google' }, env.SESSION_SECRET);
      return jsonResponse({ success: true, token, email: user.email || email, name: user.name || name });
    }

    // --- Mot de passe oublié : ne révèle jamais si l'email existe (même réponse dans tous les cas
    // — voir index.html). Génération du token + envoi de l'email se font entièrement côté Apps
    // Script (action "authForgotPassword"), qui peut envoyer un email nativement (MailApp) sans
    // clé d'API supplémentaire à configurer ici. -----------------------------------------------
    if (action === 'forgot') {
      const email = String(body.email || '').trim().toLowerCase();
      if (email) {
        try { await callAppsScript(env, 'authForgotPassword', { email, origin: new URL(request.url).origin }); }
        catch (e) { /* volontairement avalé : la réponse reste success:true quoi qu'il arrive */ }
      }
      return jsonResponse({ success: true });
    }

    if (action === 'resetConfirm') {
      const token = String(body.token || '');
      const password = String(body.password || '');
      if (!token || !password) return jsonResponse({ success: false, error: 'missing-fields' });
      if (password.length < 8) return jsonResponse({ success: false, error: 'weak-password' });
      const { hash, salt } = await hashPassword(password);
      const result = await callAppsScript(env, 'authResetPassword', { token, passwordHash: hash, passwordSalt: salt });
      if (!result.success) return jsonResponse({ success: false, error: 'invalid-token' });
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: 'server-error' });
  } catch (err) {
    return jsonResponse({ success: false, error: 'server-error' });
  }
}
