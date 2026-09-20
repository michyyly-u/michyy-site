// Cloudflare Pages Function — gère la création de compte et la connexion :
//   - action=register / login  → email + mot de passe classique
//   - action=google            → vérifie le jeton envoyé par Google Identity Services (bouton
//                                 "Se connecter avec Google" côté site) et connecte/crée le compte
//
// Le compte Discord passe par un fichier séparé (functions/api/auth-discord.js) car Discord
// fonctionne par redirection (pas par un simple jeton côté client comme Google).
//
// Configuration (Cloudflare Pages → Settings → Environment variables) :
//   SESSION_SECRET   = une chaîne aléatoire longue et unique (ex : générée sur https://randomkeygen.com,
//                       section "CodeIgniter Encryption Keys" par exemple) — sert à signer les sessions,
//                       ne la partage jamais et ne la mets jamais dans index.html.
//   GOOGLE_CLIENT_ID = le même Client ID que tu colles côté site en JS (GOOGLE_CLIENT_ID dans
//                       index.html) — sert ici à vérifier que le jeton reçu a bien été émis pour TON
//                       site (et pas un jeton Google volé ailleurs).
// GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET : déjà configurées pour sheets-proxy.js, réutilisées telles
// quelles ici, rien à ajouter pour elles.
//
// Tant que SESSION_SECRET n'est pas défini, toute cette fonction répond une erreur claire
// ("not-configured") et le site affiche un message adapté — rien d'autre n'est affecté.

import { hashPassword, signSession, callAppsScript, jsonResponse } from './_auth-shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.SESSION_SECRET) return jsonResponse({ success: false, error: 'not-configured' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ success: false, error: 'bad-request' }, 400); }
  const action = body.action;

  try {
    if (action === 'register') return await handleRegister(env, body);
    if (action === 'login') return await handleLogin(env, body);
    if (action === 'google') return await handleGoogle(env, body);
    return jsonResponse({ success: false, error: 'unknown-action' }, 400);
  } catch (err) {
    return jsonResponse({ success: false, error: 'server-error' }, 500);
  }
}

function cleanEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 200);
}

async function handleRegister(env, body) {
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 100) || email.split('@')[0];

  if (!email.includes('@')) return jsonResponse({ success: false, error: 'invalid-email' }, 400);
  if (password.length < 8) return jsonResponse({ success: false, error: 'weak-password' }, 400);

  const existing = await callAppsScript(env, 'authFindUser', { email });
  if (existing.found) return jsonResponse({ success: false, error: 'email-exists' }, 409);

  const { hash, salt } = await hashPassword(password);
  const saved = await callAppsScript(env, 'authSaveUser', {
    email, name, passwordHash: hash, passwordSalt: salt, googleId: '', discordId: ''
  });
  if (!saved.success) return jsonResponse({ success: false, error: 'save-failed' }, 500);

  const token = await signSession({ id: saved.id, email, name, method: 'email' }, env.SESSION_SECRET);
  return jsonResponse({ success: true, token, email, name });
}

async function handleLogin(env, body) {
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) return jsonResponse({ success: false, error: 'missing-fields' }, 400);

  const user = await callAppsScript(env, 'authFindUser', { email });
  if (!user.found || !user.passwordHash) return jsonResponse({ success: false, error: 'invalid-credentials' }, 401);

  const { hash } = await hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) return jsonResponse({ success: false, error: 'invalid-credentials' }, 401);

  const token = await signSession({ id: user.id, email, name: user.name, method: 'email' }, env.SESSION_SECRET);
  return jsonResponse({ success: true, token, email, name: user.name });
}

async function handleGoogle(env, body) {
  if (!env.GOOGLE_CLIENT_ID) return jsonResponse({ success: false, error: 'not-configured' }, 500);
  const idToken = String(body.idToken || '');
  if (!idToken) return jsonResponse({ success: false, error: 'missing-token' }, 400);

  // Vérification officielle et sans dépendance : l'endpoint tokeninfo de Google revérifie la
  // signature du jeton pour nous et renvoie ses infos en clair si valide.
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!verifyRes.ok) return jsonResponse({ success: false, error: 'invalid-token' }, 401);
  const payload = await verifyRes.json();
  if (payload.aud !== env.GOOGLE_CLIENT_ID) return jsonResponse({ success: false, error: 'audience-mismatch' }, 401);

  const googleId = payload.sub;
  const email = cleanEmail(payload.email);
  const name = String(payload.name || email.split('@')[0]).slice(0, 100);

  let user = await callAppsScript(env, 'authFindUser', { googleId });
  if (!user.found && email) user = await callAppsScript(env, 'authFindUser', { email });
  if (!user.found) {
    const saved = await callAppsScript(env, 'authSaveUser', { email, name, googleId, passwordHash: '', passwordSalt: '', discordId: '' });
    user = { id: saved.id, email, name };
  } else if (!user.googleId) {
    // Compte déjà créé par email, connecté pour la 1ère fois avec Google : on relie les deux plutôt
    // que de créer un doublon.
    await callAppsScript(env, 'authSaveUser', { id: user.id, email: user.email, name: user.name, googleId, passwordHash: user.passwordHash || '', passwordSalt: user.passwordSalt || '', discordId: user.discordId || '' });
  }

  const token = await signSession({ id: user.id, email: user.email || email, name: user.name || name, method: 'google' }, env.SESSION_SECRET);
  return jsonResponse({ success: true, token, email: user.email || email, name: user.name || name });
}
