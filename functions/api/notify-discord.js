/**
 * Cloudflare Pages Function — proxy Discord (équivalent de netlify/functions/notify-discord.js).
 * Transmet le message au vrai webhook Discord sans jamais l'exposer dans le code source de la page.
 *
 * Emplacement obligatoire : /functions/api/notify-discord.js à la racine du projet déployé.
 * Route générée automatiquement : /api/notify-discord (doit correspondre à WEBHOOK_URL dans le site).
 *
 * Variables d'environnement (Cloudflare Pages > Settings > Variables and secrets, en
 * Production ET Preview, type « Secret ») :
 *   - DISCORD_WEBHOOK_URL : l'URL de ton webhook Discord (obligatoire)
 *   - ADMIN_KEY           : clé longue et aléatoire (≥ 32 caractères). Un appel qui envoie
 *                           l'en-tête « x-admin-key » avec cette valeur passe sans contrôle d'origine
 *                           ni limite de débit. Facultatif.
 *   - ALLOWED_ORIGINS     : origines supplémentaires autorisées, séparées par des virgules. Facultatif.
 *   - RATE                : un KV namespace lié, pour que la limite de débit soit partagée entre
 *                           serveurs. Facultatif (sans lui, la limite est par serveur).
 *
 * Deux formats acceptés :
 *   1) JSON (commande sans fichier)
 *   2) multipart/form-data (commande avec fichiers : payload_json + files[0], files[1]…)
 *
 * Ce que le proxy impose (le script de la page ne protège rien : n'importe qui peut l'ignorer) :
 *   - origine du site obligatoire, sauf appel avec x-admin-key valide ;
 *   - 6 envois par minute et par IP ;
 *   - seuls « content » et « embeds » sont transmis (pas de username, avatar, components, tts) ;
 *   - mentions neutralisées, sauf le ping exact "@everyone" que le site utilise pour t'alerter.
 */

// Le site limite les fichiers à 10 Mo au total (ORDER_FILES_MAX_BYTES dans index.html) et à
// 10 fichiers. Petite marge pour le texte de la commande. Si tu montes la limite côté site,
// monte aussi celle-ci.
const MAX_MULTIPART_BYTES = 11 * 1024 * 1024;
const MAX_FILES_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_PER_MINUTE = 6;

const jsonResponse = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const encoder = new TextEncoder();

function safeEqual(a, b) {
  const x = encoder.encode(String(a || '')), y = encoder.encode(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const cut = (v, n) => {
  v = String(v == null ? '' : v);
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};

// Casse les mentions : @everyone, @here, <@id>, <@&rôle>
const noPing = (t) =>
  t.replace(/@(everyone|here)/gi, '@​$1').replace(/<(@[!&]?|#)(\d+)>/g, '<$1​$2>');

function cleanEmbed(e) {
  if (!e || typeof e !== 'object') return null;
  const o = {};
  if (e.title) o.title = noPing(cut(e.title, 256));
  if (e.description) o.description = noPing(cut(e.description, 4096));
  if (Number.isInteger(e.color)) o.color = e.color & 0xffffff;
  if (e.footer && e.footer.text) o.footer = { text: noPing(cut(e.footer.text, 2048)) };
  if (typeof e.timestamp === 'string' && !isNaN(Date.parse(e.timestamp))) o.timestamp = e.timestamp;
  if (Array.isArray(e.fields)) {
    o.fields = e.fields.slice(0, 25).map((f) => ({
      name: noPing(cut(f && f.name ? f.name : '—', 256)),
      value: noPing(cut(f && f.value !== '' && f.value != null ? f.value : '—', 1024)),
      inline: !!(f && f.inline)
    }));
  }
  // Pas de url / image / author / thumbnail : aucun lien ni image imposé dans ton salon.
  return o;
}

function cleanPayload(p) {
  const out = { allowed_mentions: { parse: [] } };
  if (!p || typeof p !== 'object') return out;
  if (typeof p.content === 'string' && p.content) {
    if (p.content.trim() === '@everyone') {
      out.content = '@everyone';
      out.allowed_mentions = { parse: ['everyone'] };
    } else {
      out.content = noPing(cut(p.content, 2000));
    }
  }
  if (Array.isArray(p.embeds)) {
    out.embeds = p.embeds.slice(0, 3).map(cleanEmbed).filter(Boolean);
    const total = out.embeds.reduce((s, e) =>
      s + (e.title || '').length + (e.description || '').length + (e.footer ? e.footer.text.length : 0) +
      (e.fields || []).reduce((t, f) => t + f.name.length + f.value.length, 0), 0);
    if (total > 5800) out.embeds = out.embeds.slice(0, 1);
  }
  return out;
}

// Limite de débit : mémoire du serveur + KV facultatif
const memory = new Map();
async function isRateLimited(env, ip) {
  const minute = Math.floor(Date.now() / 60000);
  const key = ip + ':' + minute;
  const count = (memory.get(key) || 0) + 1;
  memory.set(key, count);
  if (memory.size > 5000) {
    for (const k of memory.keys()) if (!k.endsWith(':' + minute)) memory.delete(k);
  }
  if (count > MAX_PER_MINUTE) return true;
  if (env.RATE && env.RATE.get) {
    const kvKey = 'nd:' + key;
    const n = parseInt((await env.RATE.get(kvKey)) || '0', 10) + 1;
    await env.RATE.put(kvKey, String(n), { expirationTtl: 120 });
    if (n > MAX_PER_MINUTE) return true;
  }
  return false;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return jsonResponse({
      success: false,
      error: "Proxy mal configuré : DISCORD_WEBHOOK_URL manquant dans les variables d'environnement Cloudflare Pages."
    }, 500);
  }

  const isAdmin = !!env.ADMIN_KEY && safeEqual(request.headers.get('x-admin-key'), env.ADMIN_KEY);

  if (!isAdmin) {
    const self = new URL(request.url).origin;
    const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const referer = request.headers.get('Referer') || '';
    const allowed = [self, ...extra].some((o) => origin === o || (!origin && referer.startsWith(o + '/')));
    if (!allowed) return jsonResponse({ success: false, error: 'Origine non autorisée.' }, 403);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await isRateLimited(env, ip)) {
      return jsonResponse({ success: false, error: 'Trop de messages, réessaie dans une minute.' }, 429);
    }
  }

  try {
    const contentType = request.headers.get('Content-Type') || '';
    const type = contentType.toLowerCase();
    const declared = Number(request.headers.get('Content-Length') || 0);

    let discordResponse;
    if (type.startsWith('multipart/form-data')) {
      if (declared > MAX_MULTIPART_BYTES) {
        return jsonResponse({ success: false, error: 'Fichiers trop lourds (10 Mo maximum au total).' }, 413);
      }
      const form = await request.formData();
      const out = new FormData();
      let payload = {};
      try { payload = JSON.parse(String(form.get('payload_json') || '{}')); } catch (e) { payload = {}; }
      out.set('payload_json', JSON.stringify(cleanPayload(payload)));

      let count = 0, size = 0;
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string' || !/^files\[\d+\]$/.test(key)) continue;
        size += value.size;
        if (++count > MAX_FILES || size > MAX_FILES_BYTES) {
          return jsonResponse({ success: false, error: 'Fichiers trop lourds ou trop nombreux (10 fichiers, 10 Mo maximum au total).' }, 413);
        }
        out.append(key, value, String(value.name || 'fichier').replace(/[^\w.\- ]/g, '_').slice(0, 80));
      }
      // Pas de Content-Type manuel : fetch génère lui-même le « boundary » du FormData.
      discordResponse = await fetch(webhookUrl, { method: 'POST', body: out });
    } else if (type.startsWith('application/json')) {
      if (declared > MAX_JSON_BYTES) {
        return jsonResponse({ success: false, error: 'Message trop long.' }, 413);
      }
      const body = JSON.stringify(cleanPayload(await request.json()));
      discordResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
    } else {
      return jsonResponse({ success: false, error: 'Format non pris en charge.' }, 415);
    }

    if (!discordResponse.ok) {
      const errText = await discordResponse.text();
      return jsonResponse({ success: false, error: 'Discord a refusé le message : ' + errText }, discordResponse.status);
    }

    return jsonResponse({ success: true }, 200);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Erreur du proxy : ' + (err && err.message ? err.message : String(err)) }, 500);
  }
}

// Toute autre méthode que POST est refusée.
export async function onRequest() {
  return jsonResponse({ success: false, error: 'Méthode non autorisée.' }, 405);
}
