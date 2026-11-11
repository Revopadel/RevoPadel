// Revo Pádel · utilidades comunes de las funciones de pago
import Stripe from "npm:stripe@17.5.0";
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

export const APP_URL = Deno.env.get("APP_URL") ?? "https://revopadel.github.io/RevoPadel/real/";
export const FEE_CENTS = 0;           // Revo no cobra gestión por pago
export const COMMISSION = 0;          // Revo no cobra comisión al club: el club recibe el 100 % de la pista (gana con la cuota mensual)
export const HOLD_MINUTES = 8;        // minutos para pagar antes de perder el hueco
export const SESSION_MINUTES = 31;    // Stripe exige que la página de pago dure al menos 30 minutos

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export class UserError extends Error {}

// ===== Stripe: cada club cobra en SU cuenta =====
// La clave del club se guarda cifrada en la base de datos y solo la lee el servidor.
// Mientras un club no tenga clave, y solo para pruebas, se usa la clave de prueba de Revo (nunca una real).
export const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,250}$/;
export const livePaymentsAllowed = () => Deno.env.get("PAGOS_REALES") === "si";
export function stripeFromKey(key: string): Stripe {
  return new Stripe(key, { apiVersion: "2024-12-18.acacia", httpClient: Stripe.createFetchHttpClient() });
}
export type ClubStripe = { st: Stripe; live: boolean; own: boolean };
export async function clubStripe(sb: SupabaseClient, clubId: string): Promise<ClubStripe> {
  const { data: key, error } = await sb.rpc("club_stripe_key", { p_club: clubId });
  if (error) throw error;
  if (key) {
    const live = /^(sk|rk)_live_/.test(key as string);
    if (live && !livePaymentsAllowed()) throw new UserError("Los pagos reales todavía no están activados en Revo");
    return { st: stripeFromKey(key as string), live, own: true };
  }
  const shared = Deno.env.get("STRIPE_SECRET_KEY");
  if (shared && shared.startsWith("sk_test_")) return { st: stripeFromKey(shared), live: false, own: false };
  throw new UserError("Este club todavía no tiene activado el pago online");
}
// Igual, pero sin fallar: devuelve null si el club no puede cobrar
export async function clubStripeOrNull(sb: SupabaseClient, clubId: string): Promise<ClubStripe | null> {
  try { return await clubStripe(sb, clubId); } catch (e) { if (!(e instanceof UserError)) console.error("stripe club", clubId, String(e).slice(0, 200)); return null; }
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export async function currentUser(req: Request): Promise<User | null> {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const c = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.getUser();
  return error ? null : data.user;
}

export async function setting(sb: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function startsAt(sb: SupabaseClient, day: string, startMin: number): Promise<Date> {
  const { data, error } = await sb.rpc("slot_starts_at", { p_day: day, p_start: startMin });
  if (error) throw error;
  return new Date(data as string);
}

export function pricePerPlayerCents(club: { cut_min: number; price_morning: number; price_afternoon: number }, startMin: number) {
  const eur = startMin < club.cut_min ? Number(club.price_morning) : Number(club.price_afternoon);
  return Math.round(eur * 100);
}

// Política de cancelación: >24 h, 100 %; 24–6 h, 75 %; <6 h, nada.
export function policyPct(start: Date, now = new Date()): number {
  const h = (start.getTime() - now.getTime()) / 3_600_000;
  if (h >= 24) return 100;
  if (h >= 6) return 75;
  return 0;
}

export const euro = (c: number) => (c / 100).toFixed(2).replace(".", ",") + " €";

type Payment = {
  id: string; user_id: string; status: string; court_cents: number; total_cents: number; refunded_cents: number;
  stripe_payment_intent: string | null; connected_account: string | null;
};

// Devuelve `amount` céntimos de un pago (sin pasar del total que queda por devolver).
export async function refund(st: Stripe, sb: SupabaseClient, p: Payment, amount: number, reason: string): Promise<number> {
  if (!p.stripe_payment_intent || (p.status !== "paid" && p.status !== "partially_refunded")) return 0;
  const left = p.total_cents - p.refunded_cents;
  const cents = Math.max(0, Math.min(Math.round(amount), left));
  if (cents === 0) return 0;
  await st.refunds.create({
    payment_intent: p.stripe_payment_intent,
    amount: cents,
    ...(p.connected_account ? { reverse_transfer: true, refund_application_fee: true } : {}),
    metadata: { payment_id: p.id, motivo: reason },
  }, { idempotencyKey: `refund-${p.id}-${p.refunded_cents}-${cents}` });
  const refunded = p.refunded_cents + cents;
  await sb.from("payments").update({
    refunded_cents: refunded,
    status: refunded >= p.total_cents ? "refunded" : "partially_refunded",
  }).eq("id", p.id);
  return cents;
}

export async function paidPayments(sb: SupabaseClient, bookingId: string, userId?: string): Promise<Payment[]> {
  let q = sb.from("payments").select("*").eq("booking_id", bookingId).in("status", ["paid", "partially_refunded"]);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Payment[];
}

// Si una reserva dividida ya tiene a todos pagados, queda confirmada.
// Devuelve true solo si en esta llamada ha pasado a confirmada.
export async function confirmIfComplete(sb: SupabaseClient, bookingId: string): Promise<boolean> {
  const { data: b } = await sb.from("bookings").select("id, court_id, status, payment_state, pay_mode").eq("id", bookingId).single();
  if (!b || b.status !== "active" || b.payment_state === "confirmed") return false;
  const { data: c } = await sb.from("courts").select("size").eq("id", b.court_id).single();
  const { count } = await sb.from("booking_players").select("id", { count: "exact", head: true })
    .eq("booking_id", bookingId).not("paid_at", "is", null);
  if (b.pay_mode === "full" || (count ?? 0) >= (c?.size ?? 4)) {
    const { data: done } = await sb.from("bookings").update({ payment_state: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", bookingId).eq("payment_state", "pending").select("id");
    return !!done?.length;
  }
  return false;
}

// Aviso de reserva confirmada a todos los jugadores con cuenta
export async function notifyConfirmed(sb: SupabaseClient, bookingId: string) {
  const { data: b } = await sb.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!b) return;
  const { data: ps } = await sb.from("booking_players").select("user_id").eq("booking_id", bookingId).not("user_id", "is", null);
  const desc = await describeBooking(sb, b);
  await notifyUsers(sb, (ps ?? []).map((p) => p.user_id as string), "Reserva confirmada · " + desc, "¡Pista confirmada!",
    () => [desc, b.pay_mode === "full" ? "La pista está pagada entera." : "Han pagado todos los jugadores.", "Nos vemos en la pista."],
    { text: "Ver el partido", url: matchUrl(bookingId) });
}

// Cierra las páginas de pago abiertas de un jugador (o de toda la reserva) para que ya no se pueda pagar
export async function expireOpenSessions(st: Stripe, sb: SupabaseClient, bookingId: string, userId?: string) {
  let q = sb.from("payments").select("id, stripe_session_id").eq("booking_id", bookingId).eq("status", "pending");
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q;
  for (const p of data ?? []) {
    if (p.stripe_session_id) {
      try { await st.checkout.sessions.expire(p.stripe_session_id); } catch (_e) { /* ya caducada o pagada */ }
    }
    await sb.from("payments").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
  }
}

// ===== Aviso de pagos de Stripe (webhook): se da de alta solo la primera vez =====
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
] as const;

// Un aviso (webhook) por club, en la cuenta de Stripe de ese club. El club va en la dirección (?club=…).
export async function ensureWebhook(st: Stripe, sb: SupabaseClient, clubId: string) {
  const { data: row } = await sb.from("club_stripe").select("webhook_secret").eq("club_id", clubId).maybeSingle();
  if (row?.webhook_secret) return;
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/stripe-webhook`;
  const url = `${base}?club=${encodeURIComponent(clubId)}`;
  const existing = await st.webhookEndpoints.list({ limit: 100 });
  for (const w of existing.data) if (w.url === url || w.url === base) await st.webhookEndpoints.del(w.id);
  const ep = await st.webhookEndpoints.create({ url, enabled_events: [...WEBHOOK_EVENTS], description: "Revo Pádel" });
  const { error } = await sb.from("club_stripe").upsert({ club_id: clubId, webhook_secret: ep.secret!, webhook_id: ep.id }, { onConflict: "club_id" });
  if (error) throw error;
}

// ===== Procesar una página de pago de Stripe (desde el aviso, al volver a la app o en la revisión) =====
// Devuelve qué ha pasado: "pagado", "devuelto", "caducado", "ya_procesado", "sin_pagar"
export async function processSession(st: Stripe, sb: SupabaseClient, s: Stripe.Checkout.Session): Promise<string> {
  if (s.status === "expired") {
    await sb.from("payments").update({ status: "expired" }).eq("stripe_session_id", s.id).eq("status", "pending");
    return "caducado";
  }
  if (s.status === "open") return "sin_pagar";
  if (s.payment_status !== "paid") return "sin_pagar";
  const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
  const now = new Date().toISOString();
  // Solo uno gana aunque lleguen a la vez el aviso y la comprobación
  const { data: won } = await sb.from("payments")
    .update({ status: "paid", stripe_payment_intent: pi, paid_at: now })
    .eq("stripe_session_id", s.id).in("status", ["pending", "expired"]).select("*");
  const p = won?.[0];
  if (!p) return "ya_procesado";

  const { data: b } = await sb.from("bookings").select("*").eq("id", p.booking_id).maybeSingle();
  const { data: me } = await sb.from("booking_players").select("*").eq("booking_id", p.booking_id).eq("user_id", p.user_id).maybeSingle();
  const already = (await paidPayments(sb, p.booking_id, p.user_id)).filter((x) => x.id !== p.id);

  // Pago que ya no sirve (reserva cancelada, jugador fuera o pago repetido): se devuelve entero
  if (!b || b.status !== "active" || !me || me.paid_at || already.length > 0 ||
      (p.kind === "full" && b.payment_state === "confirmed")) {
    await refund(st, sb, p as Payment, p.total_cents, "pago_sin_reserva");
    return "devuelto";
  }
  let confirmed = false;
  if (p.kind === "full") {
    const { data: done } = await sb.from("bookings").update({ pay_mode: "full", payment_state: "confirmed", confirmed_at: now })
      .eq("id", b.id).eq("payment_state", "pending").select("id");
    confirmed = !!done?.length;
    await sb.from("booking_players").update({ paid_at: now }).eq("booking_id", b.id).is("paid_at", null);
  } else {
    await sb.from("booking_players").update({ paid_at: now }).eq("id", me.id);
    confirmed = await confirmIfComplete(sb, b.id);
  }
  try {
    if (confirmed) await notifyConfirmed(sb, b.id);
    else if (p.user_id !== b.owner_id && b.owner_id) {
      // Al organizador: alguien se ha unido y ha pagado
      const name = await playerName(sb, p.user_id);
      const { count } = await sb.from("booking_players").select("id", { count: "exact", head: true }).eq("booking_id", b.id).not("paid_at", "is", null);
      const { data: c } = await sb.from("courts").select("size").eq("id", b.court_id).single();
      const desc = await describeBooking(sb, b);
      await notifyUsers(sb, [b.owner_id], `${name} se ha unido a tu partido`, `${name} se ha unido y ha pagado`,
        () => [desc, `Ya habéis pagado ${count ?? 0} de ${c?.size ?? 4}.`], { text: "Ver el partido", url: matchUrl(b.id) });
    }
  } catch (e) { console.error("aviso", String(e)); }
  return "pagado";
}

// Comprueba con Stripe (el de cada club) los pagos que siguen pendientes, por si el aviso no llegó
export async function syncPending(sb: SupabaseClient, filter: { bookingId?: string; userId?: string; olderThanSec?: number } = {}) {
  // Pendientes, y también las marcadas como caducadas en las últimas 6 horas (por si se llegaron a cobrar)
  let q = sb.from("payments").select("stripe_session_id, created_at, bookings!inner(club_id)").in("status", ["pending", "expired"])
    .not("stripe_session_id", "is", null).gt("created_at", new Date(Date.now() - 6 * 3_600_000).toISOString());
  if (filter.bookingId) q = q.eq("booking_id", filter.bookingId);
  if (filter.userId) q = q.eq("user_id", filter.userId);
  if (filter.olderThanSec) q = q.lt("created_at", new Date(Date.now() - filter.olderThanSec * 1000).toISOString());
  const { data, error } = await q.order("created_at").limit(40);
  if (error) console.error("syncPending", error.message);
  const out: string[] = [];
  const clients = new Map<string, ClubStripe | null>();
  for (const row of data ?? []) {
    const clubId = (row as unknown as { bookings: { club_id: string } }).bookings.club_id;
    if (!clients.has(clubId)) clients.set(clubId, await clubStripeOrNull(sb, clubId));
    const cs = clients.get(clubId);
    if (!cs) continue;
    try {
      const s = await cs.st.checkout.sessions.retrieve(row.stripe_session_id as string);
      out.push(await processSession(cs.st, sb, s));
    } catch (e) {
      console.error("syncPending", String(e).slice(0, 200));
    }
  }
  return out;
}

export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    const msg = (e as { message?: string })?.message ?? String(e);
    return json({ error: "Algo ha fallado con el pago. Inténtalo de nuevo.", detalle: msg }, 500);
  }
}

// ===== Reservas fijas semanales del club =====
export function madridDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);
}
export function addDays(day: string, n: number): string {
  const x = new Date(day + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}
export function isoWeekday(day: string): number {
  const w = new Date(day + "T12:00:00Z").getUTCDay(); return w === 0 ? 7 : w;
}
export const WINDOW_DAYS = 14;

type Fixed = { id: string; club_id: string; court_id: string; weekday: number; start_min: number; kind: string; label: string | null; until: string | null; created_by: string | null };

// Crea las reservas de los fijos para los próximos 14 días (las que aún no existan).
// Devuelve, por cada fijo, los días creados y los que estaban ocupados por otra reserva.
export async function materializeFixed(sb: SupabaseClient, onlyId?: string) {
  let q = sb.from("club_fixed").select("*").eq("active", true);
  if (onlyId) q = q.eq("id", onlyId);
  const { data: rules } = await q;
  const out: Record<string, { creadas: string[]; ocupadas: string[] }> = {};
  if (!rules?.length) return out;
  const today = madridDay();
  const last = addDays(today, WINDOW_DAYS);
  const clubs = new Map<string, { open_min: number; close_min: number; slot_min: number }>();
  for (const r of rules as Fixed[]) {
    out[r.id] = { creadas: [], ocupadas: [] };
    let club = clubs.get(r.club_id);
    if (!club) {
      const { data } = await sb.from("clubs").select("open_min, close_min, slot_min").eq("id", r.club_id).single();
      club = data!; clubs.set(r.club_id, club);
    }
    if (r.start_min < club.open_min || r.start_min + club.slot_min > club.close_min || (r.start_min - club.open_min) % club.slot_min !== 0) continue;
    // Ocupadas por otra reserva activa, o ya creadas por este fijo (aunque el club la cancelara ese día: no se vuelve a crear)
    const { data: taken } = await sb.from("bookings").select("day, fixed_id, status").eq("court_id", r.court_id)
      .eq("start_min", r.start_min).gte("day", today).lte("day", last).or(`status.eq.active,fixed_id.eq.${r.id}`);
    const busy = new Map<string, string | null>();
    for (const t of taken ?? []) if (busy.get(t.day) !== r.id) busy.set(t.day, t.fixed_id === r.id ? r.id : (t.fixed_id ?? "otra"));
    for (let i = 0; i <= WINDOW_DAYS; i++) {
      const day = addDays(today, i);
      if (isoWeekday(day) !== r.weekday) continue;
      if (r.until && day > r.until) break;
      if (busy.has(day)) { if (busy.get(day) !== r.id) out[r.id].ocupadas.push(day); continue; }
      const start = await startsAt(sb, day, r.start_min);
      if (start.getTime() <= Date.now()) continue;
      const { data: nb, error } = await sb.from("bookings").insert({
        club_id: r.club_id, court_id: r.court_id, day, start_min: r.start_min, owner_id: null,
        kind: r.kind, label: r.label, created_by: r.created_by, fixed_id: r.id,
      }).select("id").single();
      if (error) { if (error.code === "23505") out[r.id].ocupadas.push(day); else console.error("fijo", error.message); continue; }
      if (r.kind === "manual") {
        await sb.from("booking_players").insert({ booking_id: nb.id, guest_name: (r.label || "Reserva fija").slice(0, 40) });
      }
      out[r.id].creadas.push(day);
    }
  }
  return out;
}

// ===== Avisos por correo (Resend) =====
// Sin RESEND_API_KEY no se manda nada. Para escribir a cualquier jugador hace falta un dominio verificado
// en Resend (EMAIL_FROM, p. ej. "Revo Pádel <avisos@revopadel.es>"); sin él, Resend solo entrega a la cuenta dueña.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export async function sendMail(to: string, subject: string, title: string, lines: string[], cta?: { text: string; url: string }) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || !to) return false;
  const from = Deno.env.get("EMAIL_FROM") ?? "Revo Pádel <onboarding@resend.dev>";
  const html = `<div style="font-family:Arial,sans-serif;background:#f3f5f9;padding:24px">
<div style="max-width:480px;margin:auto;background:#fff;border-radius:14px;overflow:hidden">
<div style="background:#0D1A30;color:#fff;padding:18px 22px;font-size:22px;font-weight:800;font-style:italic">REV<span style="color:#D4F04A">O</span></div>
<div style="padding:22px;color:#1a2230;font-size:15px;line-height:1.5"><h2 style="margin:0 0 12px;font-size:19px">${esc(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("")}
${cta ? `<p style="margin:18px 0 4px"><a href="${cta.url}" style="background:#D4F04A;color:#0A0F05;padding:11px 18px;border-radius:10px;text-decoration:none;font-weight:700">${esc(cta.text)}</a></p>` : ""}
</div><div style="padding:12px 22px;color:#8a94a6;font-size:12px;border-top:1px solid #eef1f5">Revo Pádel · ¿Dudas? Escríbenos a revopadel.app@gmail.com</div></div></div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!r.ok) { console.error("correo", r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error("correo", String(e)); return false; }
}

export async function emailOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  try { const { data } = await sb.auth.admin.getUserById(userId); return data.user?.email ?? null; } catch { return null; }
}

// "Pista 2 · Olimpo · jueves 29 de octubre, 19:30"
export async function describeBooking(sb: SupabaseClient, b: { club_id: string; court_id: string; day: string; start_min: number }) {
  const [{ data: club }, { data: court }] = await Promise.all([
    sb.from("clubs").select("name").eq("id", b.club_id).single(),
    sb.from("courts").select("name").eq("id", b.court_id).single(),
  ]);
  const fecha = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(b.day + "T12:00:00Z"));
  const hh = String(Math.floor(b.start_min / 60)).padStart(2, "0") + ":" + String(b.start_min % 60).padStart(2, "0");
  return `${court?.name ?? "Pista"} · ${club?.name ?? ""} · ${fecha}, ${hh}`;
}

export const matchUrl = (id: string) => `${APP_URL}#p=${id}`;

// Manda el mismo aviso a varios jugadores: notificación en el móvil (si la activaron) y correo (si hay Resend)
export async function notifyUsers(sb: SupabaseClient, userIds: string[], subject: string, title: string, lines: (uid: string) => string[], cta?: { text: string; url: string }) {
  const mail = !!Deno.env.get("RESEND_API_KEY");
  for (const uid of [...new Set(userIds)]) {
    const ls = lines(uid);
    try { await sendPush(sb, uid, { title, body: ls.slice(0, 3).join("\n"), url: cta?.url ?? APP_URL }); } catch (e) { console.error("push", String(e)); }
    if (mail) {
      const to = await emailOf(sb, uid);
      if (to) await sendMail(to, subject, title, ls, cta);
    }
  }
}

// ===== Notificaciones en el móvil (Web Push) =====
// Las claves VAPID se crean solas la primera vez y se guardan en app_settings (solo las lee el servidor).
export async function vapid(sb: SupabaseClient): Promise<{ publicKey: string; privateKey: string }> {
  let pub = await setting(sb, "vapid_public"), priv = await setting(sb, "vapid_private");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // insert sin pisar: si otra llamada se adelantó, nos quedamos con las suyas
    await sb.from("app_settings").upsert([{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }], { onConflict: "key", ignoreDuplicates: true });
    pub = await setting(sb, "vapid_public"); priv = await setting(sb, "vapid_private");
  }
  return { publicKey: pub!, privateKey: priv! };
}

export async function sendPush(sb: SupabaseClient, userId: string, msg: { title: string; body: string; url: string }) {
  const { data: subs } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (!subs?.length) return 0;
  const k = await vapid(sb);
  webpush.setVapidDetails("mailto:revopadel.app@gmail.com", k.publicKey, k.privateKey);
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 3600 * 6, urgency: "high" });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);   // el móvil ya no la usa
      else console.error("push", code, String(e).slice(0, 200));
    }
  }
  return ok;
}

export async function playerName(sb: SupabaseClient, userId: string) {
  const { data } = await sb.from("profiles").select("name").eq("id", userId).maybeSingle();
  return data?.name ?? "Un jugador";
}
