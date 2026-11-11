// Revo Pádel · Stripe avisa aquí cuando un pago se completa o caduca
// Sin JWT de Supabase: la autenticidad se comprueba con la firma de Stripe.
// Cada club tiene su aviso en SU cuenta de Stripe: la dirección lleva ?club=… y la firma se comprueba con el secreto de ese club.
import Stripe from "npm:stripe@17.5.0";
import { admin, clubStripe, processSession } from "./revo.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });
  const clubId = new URL(req.url).searchParams.get("club") ?? "";
  if (!/^[a-z0-9-]{1,40}$/.test(clubId)) return new Response("ignorado");   // aviso antiguo, sin club: ya no se usa
  const sb = admin();
  const { data: row } = await sb.from("club_stripe").select("webhook_secret").eq("club_id", clubId).maybeSingle();
  const secret = row?.webhook_secret as string | undefined;
  const sig = req.headers.get("Stripe-Signature");
  if (!secret || !sig) return new Response("Sin firma", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(raw, sig, secret, undefined, cryptoProvider);
  } catch (e) {
    console.error("firma no válida", clubId, String(e).slice(0, 200));
    return new Response("Firma no válida", { status: 400 });
  }

  try {
    if (event.type.startsWith("checkout.session.")) {
      const { st } = await clubStripe(sb, clubId);
      // No nos fiamos del contenido del aviso: se vuelve a pedir la página de pago a la cuenta de ESTE club.
      // Así un club no puede dar por pagada una reserva de otro.
      const id = (event.data.object as Stripe.Checkout.Session).id;
      const session = await st.checkout.sessions.retrieve(id);
      const r = await processSession(st, sb, session);
      console.log("webhook", clubId, event.type, r);
    }
  } catch (e) {
    console.error("webhook", clubId, event.type, String(e).slice(0, 300));
    return new Response("Error", { status: 500 });   // Stripe lo reintentará
  }
  return new Response("ok");
});
