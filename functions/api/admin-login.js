// functions/api/admin-login.js
// POST {code}  -> vérifie le code CÔTÉ SERVEUR, pose un cookie de session (12 h)
// GET          -> {ok:true/false} : la session est-elle valide ?
// Variables à créer dans Cloudflare (Settings > Variables and Secrets, en "Secret") :
//   ADMIN_CODE      = ton nouveau code (long, pas 2810)
//   SESSION_SECRET  = une longue chaîne aléatoire (40+ caractères)

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
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...extra } });

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_CODE || !env.SESSION_SECRET) return json({ ok: false, error: "not-configured" }, 500);
  let code = "";
  try { code = String((await request.json()).code || ""); } catch (e) {}
  const good = safeEqual(await sign(env.SESSION_SECRET, "c:" + code), await sign(env.SESSION_SECRET, "c:" + env.ADMIN_CODE));
  if (!good) {
    await new Promise(r => setTimeout(r, 1000)); // ralentit les essais
    return json({ ok: false }, 401);
  }
  const exp = String(Date.now() + 12 * 3600 * 1000);
  const token = exp + "." + (await sign(env.SESSION_SECRET, exp));
  return json({ ok: true }, 200, {
    "Set-Cookie": `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`,
  });
}

export async function onRequestGet({ request, env }) {
  const m = /(?:^|;\s*)admin_session=([^;]+)/.exec(request.headers.get("Cookie") || "");
  if (!m || !env.SESSION_SECRET) return json({ ok: false });
  const [exp, sig] = m[1].split(".");
  const ok = !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, await sign(env.SESSION_SECRET, exp));
  return json({ ok });
}
