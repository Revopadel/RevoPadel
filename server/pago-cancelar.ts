// Revo Pádel · salirse de un partido o cancelar una reserva, con sus devoluciones
// Cuerpo: { booking_id, action: "leave" | "cancel", preview?: true }
//   leave  → un jugador que no es el organizador se sale
//   cancel → el organizador o el club cancelan la reserva entera
// Reglas:
//   · Reserva pendiente (aún no han pagado todos): se devuelve el 100 % de la pista a todos.
//   · Reserva confirmada: quien se va o cancela recibe según la política (>24 h 100 %, 24–6 h 75 %, <6 h 0 %).
//     Si cancela el organizador, a los demás se les devuelve todo. Si cancela el club, a todos todo.
//   · Las devoluciones salen de la cuenta de Stripe del club, que es donde se cobró.
import {
  admin, clubStripe, clubStripeOrNull, currentUser, describeBooking, euro, expireOpenSessions, handle, json, matchUrl, notifyUsers, paidPayments, playerName, policyPct, refund,
  startsAt, UserError,
} from "./revo.ts";

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const bookingId = String(body.booking_id ?? "");
  const action = body.action === "cancel" ? "cancel" : "leave";
  const preview = body.preview === true;
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) throw new UserError("Reserva no válida");

  const sb = admin();
  const { data: b } = await sb.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!b || b.status !== "active") throw new UserError("Esta reserva ya no existe");
  const start = await startsAt(sb, b.day, b.start_min);
  if (start.getTime() <= Date.now()) throw new UserError("Esa hora ya ha pasado");
  const { data: adm } = await sb.from("club_admins").select("user_id").eq("club_id", b.club_id).eq("user_id", user.id).maybeSingle();
  const isAdmin = !!adm;
  const isOwner = b.owner_id === user.id;
  const confirmed = b.payment_state === "confirmed";
  const pct = confirmed ? policyPct(start) : 100;

  // Qué se devuelve a cada pago: { pago, céntimos }
  const plan: { p: Awaited<ReturnType<typeof paidPayments>>[number]; cents: number }[] = [];
  if (action === "leave") {
    if (isOwner) throw new UserError("Eres el organizador: cancela la reserva");
    const { data: me } = await sb.from("booking_players").select("*").eq("booking_id", bookingId).eq("user_id", user.id).maybeSingle();
    if (!me) throw new UserError("No estás en este partido");
    for (const p of await paidPayments(sb, bookingId, user.id)) plan.push({ p, cents: p.court_cents * pct / 100 });
    const back = plan.reduce((a, x) => a + Math.round(x.cents), 0);
    if (preview) return json({ pct, refund: euro(back), refund_cents: back, confirmed, club: !!b.pay_at_club });

    // Si hay algo que devolver hace falta el Stripe del club; si no, basta con intentarlo
    const st = b.kind !== "app" ? null : plan.length ? (await clubStripe(sb, b.club_id)).st : (await clubStripeOrNull(sb, b.club_id))?.st ?? null;
    if (st) await expireOpenSessions(st, sb, bookingId, user.id);   // que no pueda pagar después de salirse
    for (const x of plan) await refund(st!, sb, x.p, x.cents, "jugador_se_sale");
    await sb.from("booking_players").delete().eq("id", me.id);
    // Partido abierto confirmado: vuelve a faltar alguien y otro puede ocupar el hueco.
    // Reserva privada confirmada: la pista sigue reservada para los demás.
    // (Las que se pagan en el club no vuelven a «pendiente»: no hay pago que esperar.)
    if (confirmed && b.pay_mode === "split" && b.is_open && !b.pay_at_club) {
      await sb.from("bookings").update({
        payment_state: "pending", confirmed_at: null,
        pay_deadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),   // otras 4 horas para encontrar a alguien
      }).eq("id", bookingId);
    }
    if (b.kind === "app" && b.owner_id && (me.paid_at || b.pay_at_club)) {   // solo si de verdad estaba dentro (había pagado, o se paga en el club)
      try {
        const name = await playerName(sb, user.id);
        const desc = await describeBooking(sb, b);
        await notifyUsers(sb, [b.owner_id], `${name} se ha salido de tu partido`, `${name} se ha salido del partido`,
          () => [desc, "Ahora hay un hueco libre. Compártelo para que se apunte otro."], { text: "Ver el partido", url: matchUrl(bookingId) });
      } catch (e) { console.error("aviso", String(e)); }
    }
    return json({ ok: true, refund: euro(back) });
  }

  // Cancelar la reserva entera
  if (!isOwner && !isAdmin) throw new UserError("No puedes cancelar esta reserva");
  for (const p of await paidPayments(sb, bookingId)) {
    let cents: number;
    if (isAdmin && !isOwner) cents = p.total_cents;                 // cancela el club: todo
    else if (p.user_id === user.id) cents = p.court_cents * pct / 100; // el organizador, según la política
    else cents = p.total_cents;                                      // los demás no tienen la culpa: todo
    plan.push({ p, cents });
  }
  const mine = plan.filter((x) => x.p.user_id === user.id).reduce((a, x) => a + Math.round(x.cents), 0);
  if (preview) return json({ pct: isAdmin && !isOwner ? 100 : pct, refund: euro(mine), refund_cents: mine, confirmed, club: !!b.pay_at_club, others: plan.length - plan.filter((x) => x.p.user_id === user.id).length });

  const st = b.kind !== "app" ? null : plan.length ? (await clubStripe(sb, b.club_id)).st : (await clubStripeOrNull(sb, b.club_id))?.st ?? null;
  if (st) await expireOpenSessions(st, sb, bookingId);   // cerrar las páginas de pago abiertas
  const back = new Map<string, number>();
  for (const x of plan) {
    const c = await refund(st!, sb, x.p, x.cents, isAdmin && !isOwner ? "cancela_club" : "cancela_organizador");
    back.set(x.p.user_id, (back.get(x.p.user_id) ?? 0) + c);
  }
  await sb.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", bookingId);
  // Aviso al resto de jugadores con cuenta
  if (b.kind === "app") {
    try {
      const { data: ps } = await sb.from("booking_players").select("user_id").eq("booking_id", bookingId).not("user_id", "is", null);
      const others = (ps ?? []).map((p) => p.user_id as string).filter((u) => u !== user.id);
      const desc = await describeBooking(sb, b);
      const who = isAdmin && !isOwner ? "El club ha cancelado esta reserva." : "El organizador ha cancelado la reserva.";
      await notifyUsers(sb, others, "Reserva cancelada · " + desc, "Reserva cancelada", (uid) => [
        desc, who,
        (back.get(uid) ?? 0) > 0 ? `Te hemos devuelto ${euro(back.get(uid)!)}. Puede tardar unos días en aparecer en tu cuenta.` : "No se te había cobrado nada.",
      ], { text: "Reservar otra hora", url: matchUrl(bookingId).split("#")[0] });
    } catch (e) { console.error("aviso", String(e)); }
  }
  return json({ ok: true, refund: euro(mine) });
}));
