// Fonctions utilitaires partagées entre auth.js et auth-discord.js.
// Ce fichier commence par un underscore : Cloudflare Pages Functions ne le traite PAS comme une
// route (donc pas de /api/_auth-shared accessible), c'est juste un module importé par les deux
// autres. Rien à configurer ici, rien à modifier.

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
function base64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = '';
  bytes.forEach(b => { str += String.fromCharCode(b); });
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecodeToString(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

// --- Mot de passe : PBKDF2 (100 000 itérations, SHA-256), équivalent raisonnable à bcrypt et
// disponible nativement via Web Crypto (aucune dépendance à installer). Le sel est généré une fois
// à l'inscription et stocké à côté du hash dans le Sheet (colonne séparée) — jamais le mot de passe
// en clair, à aucun moment, nulle part.
export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: toHex(bits), salt: toHex(salt) };
}

// --- Session : jeton signé (HMAC-SHA256) avec SESSION_SECRET, format `payload.signature` en
// base64url — l'équivalent maison d'un JWT minimal, sans dépendance externe. Le payload n'est PAS
// chiffré (juste signé) : n'y mets rien de sensible, seulement id/email/name/method.
export async function signSession(payload, secret) {
  const body = base64url(JSON.stringify({ ...payload, iat: Date.now() }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${base64url(sig)}`;
}

export async function verifySession(token, secret) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expectedSig = base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    if (expectedSig !== sig) return null;
    return JSON.parse(base64urlDecodeToString(body));
  } catch (e) {
    return null;
  }
}

// --- Appel à l'Apps Script existant (même GOOGLE_SCRIPT_URL / GOOGLE_SCRIPT_SECRET que
// functions/api/sheets-proxy.js — rien de nouveau à configurer côté variables d'environnement pour
// parler au Sheet). Voir le commentaire "onglet Users" dans index.html pour les actions
// authFindUser / authSaveUser à coller dans le Apps Script.
export async function callAppsScript(env, action, params) {
  if (!env.GOOGLE_SCRIPT_URL) throw new Error('apps-script-not-configured');
  const qs = new URLSearchParams({ secret: env.GOOGLE_SCRIPT_SECRET || '', action, ...params });
  const res = await fetch(`${env.GOOGLE_SCRIPT_URL}?${qs.toString()}`);
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('apps-script-bad-response');
  return data;
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
