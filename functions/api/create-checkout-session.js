// Cloudflare Pages Function — crée une session Stripe Checkout pour un montant donné (acompte ou
// solde), puis renvoie son URL au site, qui redirige simplement le visiteur dessus.
//
// Pourquoi une fonction et pas juste un SDK côté client (comme le bouton PayPal) ? Parce que
// Stripe ne permet pas de créer une session de paiement à montant dynamique uniquement depuis le
// navigateur (contrairement à PayPal Buttons) : ça doit se faire avec la clé secrète, donc côté
// serveur. Même raison que pour functions/api/sheets-proxy.js.
//
// Configuration (Cloudflare Pages → Settings → Environment variables) :
//   STRIPE_SECRET_KEY = ta clé secrète Stripe (Développeurs → Clés API sur dashboard.stripe.com).
//     Commence par sk_test_... pour tester sans vrai argent, sk_live_... une fois prêt en prod.
// Tant que cette variable n'est pas définie, le bouton "Payer par carte" du site affiche un message
// d'indisponibilité clair — PayPal et le reste du site continuent de fonctionner normalement.

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.STRIPE_SECRET_KEY) {
      return json({ success: false, error: 'not-configured' }, 500);
    }
    const body = await request.json().catch(() => ({}));
    const amountEuros = Number(body.amount);
    const orderId = String(body.orderId || '').slice(0, 100);
    const label = String(body.label || 'Acompte montage vidéo').slice(0, 200);

    if (!amountEuros || amountEuros < 1) {
      return json({ success: false, error: 'invalid-amount' }, 400);
    }
    const amountCents = Math.round(amountEuros * 100);
    const origin = new URL(request.url).origin;

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', `${origin}/?stripe=success&order=${encodeURIComponent(orderId)}`);
    params.set('cancel_url', `${origin}/?stripe=cancel&order=${encodeURIComponent(orderId)}`);
    params.set('line_items[0][price_data][currency]', 'eur');
    params.set('line_items[0][price_data][product_data][name]', orderId ? `${label} — commande ${orderId}` : label);
    params.set('line_items[0][price_data][unit_amount]', String(amountCents));
    params.set('line_items[0][quantity]', '1');
    if (orderId) params.set('client_reference_id', orderId);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      return json({ success: false, error: (data.error && data.error.message) || 'stripe-error' }, 500);
    }
    return json({ success: true, url: data.url });
  } catch (err) {
    return json({ success: false, error: 'server-error' }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
