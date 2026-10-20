// Cloudflare Pages Function : sert le bon <title>, la description et l'URL de partage
// pour chaque page, afin que les aperçus (WhatsApp, Discord, Facebook, Google) soient
// corrects même sans JavaScript. Le site reste une seule page index.html.
const SITE = "https://michyy-portfolio.pages.dev";
const ROUTES = {
  "/realisations": ["Réalisations · Michyy, monteur vidéo TikTok & YouTube", "Mes montages TikTok, Reels et YouTube : gaming, sport, IRL, best-of. Regarde les vidéos avant de commander (court dès 45 €)."],
  "/etudes-de-cas": ["Études de cas · Michyy, monteur vidéo", "Avant/après et résultats concrets sur des chaînes TikTok et YouTube : ce que le montage a changé."],
  "/a-propos": ["À propos · Michyy, monteur vidéo", "Qui est Michyy, comment je travaille et pour quels créateurs et marques je monte des vidéos."],
  "/offres": ["Offres et tarifs montage vidéo · dès 45 € · Michyy", "Tarifs clairs : court dès 45 €, long dès 125 €, packs et abonnements. 3 révisions incluses, devis sous 24 h."],
  "/packs": ["Packs de montage vidéo · Michyy", "Packs démarrage de chaîne, lancement produit et abonnements streamer : plusieurs vidéos, un prix fixe."],
  "/pro": ["Montage vidéo pour marques · dès 300 € · Michyy", "Contenu de marque et vidéos sponsorisées pour TikTok, Reels et YouTube, à partir de 300 €. Devis sous 24 h."],
  "/avantages": ["Fidélité et avantages · Michyy", "Parrainage, réductions et avantages pour les clients réguliers."],
  "/garanties": ["Garanties · 3 révisions incluses · Michyy", "Révisions incluses, délais annoncés et paiement sécurisé : ce que je garantis sur chaque commande."],
  "/comment-ca-marche": ["Comment ça marche · Michyy, monteur vidéo", "De la commande à la livraison : les étapes, les délais et comment envoyer tes rushs."],
  "/faq": ["FAQ · Michyy, monteur vidéo", "Délais, révisions, paiement, formats, droits : les réponses aux questions les plus fréquentes."],
  "/conditions": ["Conditions générales · Michyy", "Conditions de vente et de service pour les commandes de montage vidéo."],
  "/commander": ["Commander un montage vidéo · Michyy", "Décris ton projet et réserve ton montage en ligne : court dès 45 €, long dès 125 €. Devis sous 24 h."],
  "/suivi": ["Suivi de commande · Michyy", "Suis l'avancement de ta commande de montage vidéo avec ton code de suivi."],
};

export async function onRequest({ request, next }) {
  const res = await next();
  if (request.method !== "GET" || !(res.headers.get("content-type") || "").includes("text/html")) return res;

  const path = new URL(request.url).pathname.replace(/\/+$/, "").toLowerCase() || "/";
  const meta = ROUTES[path];

  // Chemin inconnu (hors accueil) : vraie réponse 404, la page affiche son écran « introuvable ».
  if (!meta) {
    if (path === "/" || path === "/index.html" || path.startsWith("/api/")) return res;
    return new Response(res.body, { status: 404, headers: res.headers });
  }

  const [title, desc] = meta;
  const url = SITE + path;
  const attr = (name, value) => ({ element: (e) => e.setAttribute(name, value) });
  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', attr("content", desc))
    .on('meta[property="og:title"]', attr("content", title))
    .on('meta[property="og:description"]', attr("content", desc))
    .on('meta[property="og:url"]', attr("content", url))
    .on('meta[name="twitter:title"]', attr("content", title))
    .on('meta[name="twitter:description"]', attr("content", desc))
    .on('link[rel="canonical"]', attr("href", url))
    .transform(res);
}
