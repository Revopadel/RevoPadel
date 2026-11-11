// Revo Pádel · crea la página de pago de Stripe para una reserva
// Cuerpo: { booking_id, kind: "share" (mi parte) | "full" (pista entera) }
import {
  admin, APP_URL, clubStripe, currentUser, ensureWebhook, euro, FEE_CENTS, handle, HOLD_MINUTES, json, pricePerPlayerCents,
  SESSION_MINUTES, startsAt, UserError,
} from "./revo.ts";

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const bookingId = String(body.booking_id ?? "");
  const kind = body.kind === "full" ? "full" : "share";
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) throw new UserError("Reserva no válida");

  const sb = admin();
  const { data: b } = await sb.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!b || b.status !== "active" || b.kind !== "app") throw new UserError("Esta reserva ya no existe");
  if (b.payment_state === "confirmed") throw new UserError("Esta reserva ya está pagada");
  const { data: club } = await sb.from("clubs").select("*").eq("id", b.club_id).single();
  const { data: court } = await sb.from("courts").select("*").eq("id", b.court_id).single();
  const { data: me } = await sb.from("booking_players").select("*").eq("booking_id", bookingId).eq("user_id", user.id).maybeSingle();
  if (!me) throw new UserError("Primero apúntate al partido");
  if (me.paid_at) throw new UserError("Ya has pagado tu parte");

  if (b.pay_deadline && new Date(b.pay_deadline).getTime() < Date.now()) {
    throw new UserError(b.is_open ? "Este partido ya no se completó a tiempo" : "Se acabaron los 20 minutos para pagar esta reserva");
  }
  const start = await startsAt(sb, b.day, b.start_min);
  const msLeft = start.getTime() - Date.now();
  if (msLeft <= 0) throw new UserError("El partido ya ha empezado");
  if (kind === "share" && msLeft <= 2 * 3_600_000) {
    throw new UserError("Quedan menos de 2 horas: solo se puede pagar la pista entera");
  }
  if (kind === "full") {
    if (b.owner_id !== user.id) throw new UserError("Solo quien reserva puede pagar la pista entera");
    const { count } = await sb.from("booking_players").select("id", { count: "exact", head: true })
      .eq("booking_id", bookingId).not("paid_at", "is", null);
    if ((count ?? 0) > 0) throw new UserError("Alguien ya ha pagado su parte: paga solo la tuya");
  }

  const per = pricePerPlayerCents(club, b.start_min);
  const courtCents = kind === "full" ? per * court.size : per;
  const total = courtCents + FEE_CENTS;
  // El cobro se hace en la cuenta de Stripe del club: el dinero no pasa por Revo
  const { st } = await clubStripe(sb, b.club_id);

  const { data: pay, error: pe } = await sb.from("payments").insert({
    booking_id: bookingId, user_id: user.id, kind, court_cents: courtCents, fee_cents: FEE_CENTS,
    app_fee_cents: 0, total_cents: total, connected_account: null,
  }).select("id").single();
  if (pe) throw pe;

  const hh = String(Math.floor(b.start_min / 60)).padStart(2, "0") + ":" + String(b.start_min % 60).padStart(2, "0");
  const fecha = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(b.day + "T12:00:00Z"));
  const meta = { booking_id: bookingId, user_id: user.id, payment_id: pay.id, kind, club_id: b.club_id };
  const back = (estado: string) => `${APP_URL}?pago=${estado}&b=${bookingId}`;

  try { await ensureWebhook(st, sb, b.club_id); } catch (e) { console.error("webhook", String(e).slice(0, 200)); }
  let session;
  try {
    session = await st.checkout.sessions.create({
      mode: "payment",
      locale: "es",
      customer_email: user.email ?? undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: courtCents,
            product_data: {
              name: `${court.name} · ${club.name} · ${fecha}, ${hh}`,
              description: kind === "full" ? `Pista entera (${court.size} jugadores)` : "Tu parte de la pista",
            },
          },
        },
        ...(FEE_CENTS > 0 ? [{ quantity: 1, price_data: { currency: "eur", unit_amount: FEE_CENTS, product_data: { name: "Gestión Revo" } } }] : []),
      ],
      payment_intent_data: {
        metadata: meta,
        description: `Revo · ${club.name} · ${court.name} · ${b.day} ${hh}`,
      },
      metadata: meta,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      success_url: back("ok"),
      cancel_url: back("cancelado"),
    }, { idempotencyKey: `checkout-${pay.id}` });
  } catch (e) {
    await sb.from("payments").update({ status: "expired" }).eq("id", pay.id);
    throw e;
  }

  await sb.from("payments").update({ stripe_session_id: session.id }).eq("id", pay.id);
  // Mientras está pagando, no se le quita el hueco
  const hold = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
  await sb.from("booking_players").update({ hold_until: hold }).eq("id", me.id);
  if (b.owner_id === user.id) await sb.from("bookings").update({ hold_until: hold }).eq("id", bookingId);

  return json({ url: session.url, total: euro(total) });
}));
