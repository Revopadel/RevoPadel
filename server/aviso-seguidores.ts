// Revo Pádel · aviso a los seguidores cuando alguien abre un partido
// La llama la base de datos en cuanto el organizador de un partido abierto paga su parte
// (o nada más crearlo, si el partido se paga en el club).
// Es segura aunque la llame cualquiera: comprueba todo de nuevo y solo avisa una vez por partido.
// Cuerpo: { booking_id }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const APP_URL = Deno.env.get("APP_URL") ?? "https://revopadel.github.io/RevoPadel/real/";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const lvl = (x: number) => Number(x).toFixed(1).replace(".", ",");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const { booking_id } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/.test(String(booking_id ?? ""))) return json({ error: "Reserva no válida" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: b } = await sb.from("bookings").select("*").eq("id", booking_id).maybeSingle();
  if (!b || b.status !== "active" || !b.is_open || !b.owner_id) return json({ avisados: 0, motivo: "no_aplica" });
  if (!b.pay_at_club && b.payment_state !== "pending") return json({ avisados: 0, motivo: "no_aplica" });
  const { data: players } = await sb.from("booking_players").select("user_id, paid_at").eq("booking_id", b.id);
  const owner = (players ?? []).find((p) => p.user_id === b.owner_id);
  if (!owner) return json({ avisados: 0, motivo: "no_aplica" });
  if (!b.pay_at_club && !owner.paid_at) return json({ avisados: 0, motivo: "organizador_sin_pagar" });
  const { data: court } = await sb.from("courts").select("name, size").eq("id", b.court_id).single();
  if ((players?.length ?? 0) >= (court?.size ?? 4)) return json({ avisados: 0, motivo: "completo" });

  // Una sola vez por partido
  const { error: dup } = await sb.from("follow_notices").insert({ booking_id: b.id });
  if (dup) return json({ avisados: 0, motivo: "ya_avisado" });

  const inside = new Set((players ?? []).map((p) => p.user_id));
  const { data: fs } = await sb.from("follows").select("follower_id").eq("followee_id", b.owner_id).limit(1000);
  const ids = (fs ?? []).map((f) => f.follower_id as string).filter((id) => !inside.has(id));
  if (!ids.length) return json({ avisados: 0, motivo: "sin_seguidores" });

  const [{ data: who }, { data: club }] = await Promise.all([
    sb.from("profiles").select("name").eq("id", b.owner_id).maybeSingle(),
    sb.from("clubs").select("name").eq("id", b.club_id).single(),
  ]);
  const fecha = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(b.day + "T12:00:00Z"));
  const hh = String(Math.floor(b.start_min / 60)).padStart(2, "0") + ":" + String(b.start_min % 60).padStart(2, "0");
  const faltan = Math.max(1, (court?.size ?? 4) - (players?.length ?? 1));
  const msg = JSON.stringify({
    title: `${who?.name ?? "Alguien a quien sigues"} ha abierto un partido`,
    body: `${club?.name ?? ""} · ${fecha}, ${hh} · ${court?.name ?? ""}` + (b.lvl_min != null ? `\nNivel ${lvl(b.lvl_min)}–${lvl(b.lvl_max)}` : "") +
      `\nFalta${faltan > 1 ? "n" : ""} ${faltan} jugador${faltan > 1 ? "es" : ""}. ¡Apúntate!`,
    url: `${APP_URL}#p=${b.id}`,
  });

  const { data: keys } = await sb.from("app_settings").select("key, value").in("key", ["vapid_public", "vapid_private"]);
  const k = Object.fromEntries((keys ?? []).map((r) => [r.key, r.value]));
  if (!k.vapid_public || !k.vapid_private) return json({ avisados: 0, motivo: "sin_claves" });
  webpush.setVapidDetails("mailto:revopadel.app@gmail.com", k.vapid_public, k.vapid_private);

  const { data: subs } = await sb.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", ids);
  let ok = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { TTL: 3600 * 4, urgency: "normal" });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, String(e).slice(0, 200));
    }
  }
  return json({ avisados: ok, seguidores: ids.length });
});
