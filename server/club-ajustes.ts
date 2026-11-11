// Revo Pádel · panel del club (solo administradores del club)
// Cuerpo: { club_id, action, ... }
//   caja        { day }                         → lo cobrado ese día
//   guardar     { price_morning, price_afternoon, cut_min, open_min, close_min, contact_phone?, contact_email? } → precios, horario y contacto
//   fijos       {}                              → lista de reservas fijas
//   fijo_crear  { court_id, weekday, start_min, kind, label?, until? }
//   fijo_borrar { id }                          → deja de repetirse y quita las próximas
import { admin, currentUser, euro, handle, json, madridDay, materializeFixed, UserError } from "./revo.ts";

const isDay = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.club_id ?? "");
  const action = String(body.action ?? "");
  const sb = admin();
  const { data: adm } = await sb.from("club_admins").select("user_id").eq("club_id", clubId).eq("user_id", user.id).maybeSingle();
  if (!adm) throw new UserError("Solo el club puede hacer esto");
  const { data: club } = await sb.from("clubs").select("*").eq("id", clubId).single();
  const today = madridDay();

  // ----- Caja del día -----
  if (action === "caja") {
    if (!isDay(body.day)) throw new UserError("Día no válido");
    const { data: bks } = await sb.from("bookings").select("id, kind, court_id, start_min, status")
      .eq("club_id", clubId).eq("day", body.day);
    const ids = (bks ?? []).map((b) => b.id);
    const { data: pays } = ids.length
      ? await sb.from("payments").select("status, court_cents, refunded_cents, app_fee_cents, fee_cents, connected_account").in("booking_id", ids)
        .in("status", ["paid", "partially_refunded", "refunded"])
      : { data: [] };
    let pistas = 0, devuelto = 0, comision = 0, pagos = 0;
    for (const p of pays ?? []) {
      const net = Math.max(0, p.court_cents - p.refunded_cents);
      pistas += net; devuelto += p.refunded_cents; if (net > 0) pagos++;
    }
    const { data: courts } = await sb.from("courts").select("id, size").eq("club_id", clubId);
    const size = new Map((courts ?? []).map((c) => [c.id, c.size]));
    let mostrador = 0, telefono = 0;
    for (const b of bks ?? []) {
      if (b.status !== "active" || b.kind !== "manual") continue;
      telefono++;
      const eur = b.start_min < club.cut_min ? Number(club.price_morning) : Number(club.price_afternoon);
      mostrador += Math.round(eur * 100) * (size.get(b.court_id) ?? 4);
    }
    return json({
      pagos, pistas: euro(pistas), pistas_cents: pistas, comision: euro(comision), neto: euro(pistas - comision),
      devuelto: euro(devuelto), telefono, mostrador: euro(mostrador), mostrador_cents: mostrador,
    });
  }

  // ----- Precios y horario -----
  if (action === "guardar") {
    const pm = Number(body.price_morning), pa = Number(body.price_afternoon);
    const cut = Number(body.cut_min), open = Number(body.open_min), close = Number(body.close_min);
    for (const p of [pm, pa]) if (!Number.isFinite(p) || p < 0 || p > 50) throw new UserError("El precio tiene que estar entre 0 y 50 €");
    for (const m of [cut, open, close]) if (!Number.isInteger(m) || m < 0 || m > 1440 || m % 15 !== 0) throw new UserError("Hora no válida");
    if (close - open < club.slot_min) throw new UserError("El club tiene que abrir al menos " + club.slot_min / 60 + " h");
    if (cut < open || cut > close) throw new UserError("La hora de tarde tiene que estar dentro del horario");
    const phone = String(body.contact_phone ?? "").trim().replace(/\s+/g, " ");
    const email = String(body.contact_email ?? "").trim().toLowerCase();
    if (phone && !/^\+?[0-9 ]{9,18}$/.test(phone)) throw new UserError("El teléfono no es válido");
    if (email && (email.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new UserError("El correo no es válido");
    // Las reservas futuras tienen que seguir cuadrando con el nuevo horario
    const { data: fut } = await sb.from("bookings").select("day, start_min").eq("club_id", clubId).eq("status", "active").gte("day", today);
    const bad = (fut ?? []).filter((b) => b.start_min < open || b.start_min + club.slot_min > close || (b.start_min - open) % club.slot_min !== 0);
    if (bad.length) throw new UserError(`Hay ${bad.length} reserva(s) próximas que quedarían fuera del nuevo horario. Cancélalas antes o elige otro horario.`);
    const { data: fx } = await sb.from("club_fixed").select("start_min").eq("club_id", clubId).eq("active", true);
    if ((fx ?? []).some((f) => f.start_min < open || f.start_min + club.slot_min > close || (f.start_min - open) % club.slot_min !== 0)) {
      throw new UserError("Hay reservas fijas que quedarían fuera del nuevo horario. Quítalas antes.");
    }
    const { error } = await sb.from("clubs").update({
      price_morning: Math.round(pm * 100) / 100, price_afternoon: Math.round(pa * 100) / 100, cut_min: cut, open_min: open, close_min: close,
      contact_phone: phone || null, contact_email: email || null,
    }).eq("id", clubId);
    if (error) throw error;
    return json({ ok: true });
  }

  // ----- Reservas fijas -----
  if (action === "fijos") {
    const { data } = await sb.from("club_fixed").select("id, court_id, weekday, start_min, kind, label, until")
      .eq("club_id", clubId).eq("active", true).order("weekday").order("start_min");
    return json({ fijos: (data ?? []).filter((f) => !f.until || f.until >= today) });
  }

  if (action === "fijo_crear") {
    const courtId = String(body.court_id ?? "");
    const weekday = Number(body.weekday), start = Number(body.start_min);
    const kind = body.kind === "blocked" ? "blocked" : "manual";
    const label = String(body.label ?? "").trim().slice(0, 40) || null;
    const until = body.until ? String(body.until) : null;
    const { data: court } = await sb.from("courts").select("id").eq("id", courtId).eq("club_id", clubId).eq("active", true).maybeSingle();
    if (!court) throw new UserError("Pista no encontrada");
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new UserError("Día de la semana no válido");
    if (!Number.isInteger(start) || start < club.open_min || start + club.slot_min > club.close_min || (start - club.open_min) % club.slot_min !== 0) {
      throw new UserError("Ese horario no existe");
    }
    if (until && (!isDay(until) || until < today)) throw new UserError("La fecha final no es válida");
    const { data: dup } = await sb.from("club_fixed").select("id").eq("court_id", courtId).eq("weekday", weekday)
      .eq("start_min", start).eq("active", true).maybeSingle();
    if (dup) throw new UserError("Ya hay una reserva fija a esa hora");
    const { data: rule, error } = await sb.from("club_fixed").insert({
      club_id: clubId, court_id: courtId, weekday, start_min: start, kind, label, until, created_by: user.id,
    }).select("id").single();
    if (error) throw error;
    const r = (await materializeFixed(sb, rule.id))[rule.id] ?? { creadas: [], ocupadas: [] };
    return json({ ok: true, id: rule.id, ...r });
  }

  if (action === "fijo_borrar") {
    const id = String(body.id ?? "");
    const { data: rule } = await sb.from("club_fixed").select("id").eq("id", id).eq("club_id", clubId).maybeSingle();
    if (!rule) throw new UserError("Esa reserva fija ya no existe");
    await sb.from("club_fixed").update({ active: false }).eq("id", id);
    // Quita las próximas que creó (solo las de hoy en adelante; son del club, no hay pagos)
    const { data: next } = await sb.from("bookings").select("id, day, start_min").eq("fixed_id", id).eq("status", "active").gte("day", today)
      .in("kind", ["manual", "blocked"]);
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":");
    const nowMin = +hm[0] * 60 + +hm[1];
    const ids = (next ?? []).filter((b) => b.day > today || b.start_min > nowMin).map((b) => b.id);
    if (ids.length) await sb.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).in("id", ids);
    return json({ ok: true, quitadas: ids.length });
  }

  throw new UserError("Acción no válida");
}));
