// Revo Pádel · revisión automática (cada minuto)
//  1. Quien se apuntó y no pagó en su plazo pierde el hueco.
//  2. Si el organizador no paga en su plazo, la reserva se libera (y se devuelve todo a quien hubiera pagado).
//  3. Plazo para completarse desde que se crea: privada 20 minutos, partido abierto 4 horas.
//     Si vence sin que hayan pagado todos, se libera la pista y se devuelve el 100 % (gestión incluida).
//  4. Y en cualquier caso, si 2 horas antes del partido no han pagado todos, se cancela igual.
import {
  admin, type ClubStripe, clubStripeOrNull, describeBooking, ensureWebhook, euro, expireOpenSessions, handle, json, materializeFixed, matchUrl, notifyUsers, paidPayments, refund, startsAt,
  syncPending,
} from "./revo.ts";

const WHY: Record<string, string> = {
  privada_20min: "No pagaron todos en los 20 minutos que hay para completar el pago, así que la pista se ha liberado.",
  abierto_4h: "El partido no se completó en las 4 horas que tenía para encontrar jugadores, así que se ha cancelado.",
  incompleta_2h: "A 2 horas del partido no habían pagado todos, así que se ha cancelado.",
  organizador_no_pago: "El organizador no completó su pago, así que la reserva se ha anulado.",
};

Deno.serve((req) => handle(req, async () => {
  const sb = admin();
  const now = new Date();
  const out = { huecos_liberados: 0, reservas_liberadas: 0, canceladas_2h: 0, devoluciones: 0 };
  // El Stripe de cada club (null si ese club no puede cobrar)
  const clients = new Map<string, ClubStripe | null>();
  const stripeOf = async (clubId: string) => {
    if (!clients.has(clubId)) clients.set(clubId, await clubStripeOrNull(sb, clubId));
    return clients.get(clubId)?.st ?? null;
  };

  // Antes de nada: que cada club tenga su aviso de pagos dado de alta, y comprobar los pagos pendientes
  // de hace más de 1 minuto por si algún aviso de Stripe no llegó
  const { data: clubs } = await sb.from("clubs").select("id");
  for (const c of clubs ?? []) {
    const st = await stripeOf(c.id);
    if (st) { try { await ensureWebhook(st, sb, c.id); } catch (e) { console.error("webhook", c.id, String(e).slice(0, 200)); } }
  }
  await syncPending(sb, { olderThanSec: 60 });

  // Reservas fijas semanales: crear las que entran en los próximos 14 días
  try { await materializeFixed(sb); } catch (e) { console.error("fijos", String(e)); }

  const { data: pend } = await sb.from("bookings").select("*")
    .eq("status", "active").eq("kind", "app").eq("payment_state", "pending");

  for (const b of pend ?? []) {
    const start = await startsAt(sb, b.day, b.start_min);
    const { data: players } = await sb.from("booking_players").select("*").eq("booking_id", b.id);
    const owner = (players ?? []).find((p) => p.user_id === b.owner_id);
    const ownerExpired = owner && !owner.paid_at && b.hold_until && new Date(b.hold_until) < now;
    const late = start.getTime() - now.getTime() <= 2 * 3_600_000;
    const deadlineExpired = !!b.pay_deadline && new Date(b.pay_deadline) < now;

    if (ownerExpired || late || deadlineExpired) {
      const reason = deadlineExpired ? (b.is_open ? "abierto_4h" : "privada_20min") : late ? "incompleta_2h" : "organizador_no_pago";
      const st = await stripeOf(b.club_id);
      const paid = await paidPayments(sb, b.id);
      if (paid.length && !st) { console.error("sin Stripe para devolver", b.id); continue; }   // no se cancela sin poder devolver
      if (st) await expireOpenSessions(st, sb, b.id);
      const back = new Map<string, number>();
      for (const p of paid) {
        const c = await refund(st!, sb, p, p.total_cents, reason);
        back.set(p.user_id, (back.get(p.user_id) ?? 0) + c);
        out.devoluciones++;
      }
      await sb.from("bookings").update({ status: "cancelled", cancelled_at: now.toISOString() }).eq("id", b.id);
      // Aviso a los jugadores (si el organizador simplemente no pagó y nadie más pagó, no hace falta)
      if (!(reason === "organizador_no_pago" && back.size === 0)) {
        try {
          const desc = await describeBooking(sb, b);
          const uids = (players ?? []).map((p) => p.user_id).filter(Boolean) as string[];
          await notifyUsers(sb, uids, "Reserva cancelada · " + desc, "Reserva cancelada", (uid) => [
            desc, WHY[reason],
            (back.get(uid) ?? 0) > 0 ? `Te hemos devuelto ${euro(back.get(uid)!)}. Puede tardar unos días en aparecer en tu cuenta.` : "No se te había cobrado nada.",
          ], { text: "Reservar otra hora", url: matchUrl(b.id).split("#")[0] });
        } catch (e) { console.error("aviso", String(e)); }
      }
      if (late && !deadlineExpired) out.canceladas_2h++; else out.reservas_liberadas++;
      continue;
    }

    for (const p of players ?? []) {
      if (p.user_id && p.user_id !== b.owner_id && !p.paid_at && p.hold_until && new Date(p.hold_until) < now) {
        const stp = await stripeOf(b.club_id);
        if (stp) await expireOpenSessions(stp, sb, b.id, p.user_id);
        await sb.from("booking_players").delete().eq("id", p.id);
        out.huecos_liberados++;
      }
    }
  }
  return json(out);
}));
