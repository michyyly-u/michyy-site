// functions/api/_middleware.js
// S'exécute AVANT chaque fonction /api/* (donc avant sheets-proxy.js, sans le modifier).
// Les actions "admin" sont refusées (401) tant que la session admin n'est pas valide.

// Liste FINALE (déduite de ton index.html) : actions réservées au panneau admin.
const ADMIN_ACTIONS = new Set([
  "list", "delete", "setStatus", "saveBackup",
  "setAnnouncement", "setBlockedDays", "setHiddenSections",
  "npsList", "previewOpens", "listClientFiles",
  "promoCreate", "promoDelete",
]);
// "update" sert aux DEUX : tes clients l'utilisent pour envoyer une commande (toujours avec ce statut),
// et toi pour modifier une commande. Sans session, seul ce statut de création est accepté.
const CLIENT_UPDATE_STATUS = "🟠 Envoyée, en attente de réponse";
// Restent publiques (utilisées par les visiteurs) : getStatus, getAnnouncement, getBlockedDays, getHiddenSections,
// promoList, promoDisabledList, saveDraft, getDraft, clientFeedback, npsLog, previewOpen, rushsReceived,
// emailNotifyOptIn, submitEssai, uploadClientFile, toolStats, public*.

const enc = new TextEncoder();
async function sign(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sessionOk(request, env) {
  const m = /(?:^|;\s*)admin_session=([^;]+)/.exec(request.headers.get("Cookie") || "");
  if (!m || !env.SESSION_SECRET) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env.SESSION_SECRET, exp));
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (url.pathname === "/api/sheets-proxy") {
    let action = url.searchParams.get("action");
    let status = url.searchParams.get("status");
    if (!action && request.method === "POST") {
      try { const b = await request.clone().json(); action = b.action; status = b.status; } catch (e) {}
    }
    const needsAuth = ADMIN_ACTIONS.has(action) || (action === "update" && status !== CLIENT_UPDATE_STATUS);
    if (needsAuth && !(await sessionOk(request, env))) {
      return new Response(JSON.stringify({ success: false, error: "unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
  }
  return next();
}
