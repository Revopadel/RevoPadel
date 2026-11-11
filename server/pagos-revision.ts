// Revo Pádel · revisión automática (cada minuto)
//  1. Quien se apuntó y no pagó en su plazo pierde el hueco.
//  2. Si el organizador no paga en su plazo, la reserva se libera (y se devuelve todo a quien hubiera pagado).
//  3. Plazo para completarse desde que se crea: privada 20 minutos, partido abierto 4 horas.
//     Si vence sin que hayan pagado todos, se libera la pista y se devuelve el 100 % (gestión incluida).
//  4. Y en cualquier caso, si 2 horas antes del partido no han pagado todos, se cancela igual.
//  5. Reservas que se pagan en el club (no hay pago que las sujete, así que se protegen de otra forma):
//     · quien reservó tiene que confirmar que va entre 24 h y 12 h antes; se le recuerda dos veces (nunca de madrugada).
//       Si a 12 h del partido no ha confirmado, la pista se libera para que el club pueda volver a llenarla.
//     · un partido abierto que a 5 h de empezar sigue sin completarse también se libera.
import {
  addDays, admin, type ClubStripe, clubStripeOrNull, describeBooking, madridDay, ensureWebhook, euro, expireOpenSessions, handle, json, materializeFixed, matchUrl, notifyUsers, paidPayments, refund, startsAt,
  syncPending,
} from "./revo.ts";

const CONFIRM_BY_H = 12;   // horas antes del partido en que se libera una reserva sin confirmar (pago en el club)
const OPEN_FULL_BY_H = 5;  // horas antes en que se libera un partido abierto sin completar (pago en el club)

const WHY: Record<string, string> = {
  privada_20min: "No pagaron todos en los 20 minutos que hay para completar el pago, así que la pista se ha liberado.",
  abierto_4h: "El partido no se completó en las 4 horas que tenía para encontrar jugadores, así que se ha cancelado.",
  incompleta_2h: "A 2 horas del partido no habían pagado todos, así que se ha cancelado.",
  organizador_no_pago: "El organizador no completó su pago, así que la reserva se ha anulado.",
};

Deno.serve((req) => handle(req, async () => {
  const sb = admin();
  const now = new Date();
  const out = { huecos_liberados: 0, reservas_liberadas: 0, canceladas_2h: 0, devoluciones: 0, club_sin_confirmar: 0, club_sin_completar: 0, recordatorios: 0 };
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

  // ----- Reservas que se pagan en el club -----
  const today = madridDay(now);
  const { data: atClub } = await sb.from("bookings").select("*")
    .eq("status", "active").eq("kind", "app").eq("pay_at_club", true).gte("day", today).lte("day", addDays(today, 1));
  for (const b of atClub ?? []) {
    try {
      const start = await startsAt(sb, b.day, b.start_min);
      const hrs = (start.getTime() - now.getTime()) / 3_600_000;
      if (hrs <= 0 || hrs > 24) continue;
      const { data: players } = await sb.from("booking_players").select("user_id").eq("booking_id", b.id);
      const { data: court } = await sb.from("courts").select("size").eq("id", b.court_id).single();
      const uids = (players ?? []).map((p) => p.user_id).filter(Boolean) as string[];
      const free = async (why: string) => {
        const { data: done } = await sb.from("bookings").update({ status: "cancelled", cancelled_at: now.toISOString() })
          .eq("id", b.id).eq("status", "active").select("id");
        if (!done?.length) return false;
        const desc = await describeBooking(sb, b);
        await notifyUsers(sb, uids, "Reserva cancelada · " + desc, "Reserva cancelada", () => [desc, why, "No se te había cobrado nada."],
          { text: "Reservar otra hora", url: matchUrl(b.id).split("#")[0] });
        return true;
      };
      if (!b.attend_confirmed_at && hrs <= CONFIRM_BY_H) {
        if (await free("No se confirmó la asistencia a tiempo, así que la pista se ha liberado para otros jugadores.")) out.club_sin_confirmar++;
        continue;
      }
      if (b.is_open && (players?.length ?? 0) < (court?.size ?? 4) && hrs <= OPEN_FULL_BY_H) {
        if (await free(`A ${OPEN_FULL_BY_H} horas del partido no se había completado, así que se ha cancelado y la pista queda libre.`)) out.club_sin_completar++;
        continue;
      }
      if (!b.attend_confirmed_at && b.owner_id) {
        const want = hrs <= CONFIRM_BY_H + 4 ? 2 : 1;   // un aviso al abrirse el plazo (24 h antes) y otro 4 h antes de que se cierre
        const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(now));
        const quiet = hourNow >= 23 || hourNow < 8;        // de madrugada no se molesta: el aviso sale a las 8
        if (!quiet && (b.attend_reminders ?? 0) < want) {
          const { data: mark } = await sb.from("bookings").update({ attend_reminders: want }).eq("id", b.id).eq("attend_reminders", b.attend_reminders ?? 0).select("id");
          if (mark?.length) {
            const desc = await describeBooking(sb, b);
            const limit = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).format(new Date(start.getTime() - CONFIRM_BY_H * 3_600_000));
            await notifyUsers(sb, [b.owner_id], "Confirma tu reserva · " + desc, want === 2 ? "Último aviso: confirma que vas" : "¿Sigues viniendo? Confírmalo",
              () => [desc, `Confirma en la app antes de las ${limit}. Si no, la pista se libera para otros jugadores.`], { text: "Confirmar", url: matchUrl(b.id) });
            out.recordatorios++;
          }
        }
      }
    } catch (e) { console.error("pago en club", b.id, String(e).slice(0, 200)); }
  }
  return json(out);
}));
