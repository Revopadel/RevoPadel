// Revo Pádel · aviso cuando se libera una hora que alguien esperaba
// La llama la base de datos cuando una reserva se cancela o se borra.
// Es segura aunque la llame cualquiera: comprueba que la hora está libre de verdad,
// que aún no ha pasado, y avisa una sola vez (el aviso se borra al enviarse).
// Cuerpo: { court_id, day, start_min }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const APP_URL = Deno.env.get("APP_URL") ?? "https://revopadel.github.io/RevoPadel/real/";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const { court_id, day, start_min } = await req.json().catch(() => ({}));
  if (!/^[a-z0-9-]{1,60}$/i.test(String(court_id ?? "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? "")) || !Number.isInteger(start_min)) {
    return json({ error: "Datos no válidos" }, 400);
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // ¿Sigue en el futuro? (hora de Madrid)
  const { data: startsOk } = await sb.rpc("slot_in_future", { p_day: day, p_start: start_min });
  if (!startsOk) return json({ avisados: 0, motivo: "pasada" });

  // ¿Está libre de verdad? (puede que otra reserva o un bloqueo la ocupe)
  const { count } = await sb.from("bookings").select("id", { count: "exact", head: true })
    .eq("court_id", court_id).eq("day", day).eq("start_min", start_min).eq("status", "active");
  if ((count ?? 0) > 0) return json({ avisados: 0, motivo: "ocupada" });

  // Se borran los avisos al enviarlos: así nadie recibe el mismo aviso dos veces
  const { data: ws } = await sb.from("slot_watches").delete()
    .eq("court_id", court_id).eq("day", day).eq("start_min", start_min).select("user_id");
  const ids = [...new Set((ws ?? []).map((w) => w.user_id as string))];
  if (!ids.length) return json({ avisados: 0, motivo: "nadie_esperaba" });

  const { data: court } = await sb.from("courts").select("name, club_id").eq("id", court_id).single();
  const { data: club } = await sb.from("clubs").select("name").eq("id", court?.club_id ?? "").maybeSingle();
  const fecha = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z"));
  const hh = String(Math.floor(start_min / 60)).padStart(2, "0") + ":" + String(start_min % 60).padStart(2, "0");
  const msg = JSON.stringify({
    title: "Pista libre",
    body: `${court?.name ?? ""} · ${fecha}, ${hh}` + (club?.name ? `\n${club.name}` : ""),
    url: `${APP_URL}#d=${day}`,
  });

  const { data: keys } = await sb.from("app_settings").select("key, value").in("key", ["vapid_public", "vapid_private"]);
  const k = Object.fromEntries((keys ?? []).map((r) => [r.key, r.value]));
  if (!k.vapid_public || !k.vapid_private) return json({ avisados: 0, motivo: "sin_claves" });
  webpush.setVapidDetails("mailto:revopadel.app@gmail.com", k.vapid_public, k.vapid_private);

  const { data: subs } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", ids);
  let ok = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { TTL: 3600 * 2, urgency: "high" });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push", code, String(e).slice(0, 200));
    }
  }
  return json({ avisados: ok, esperaban: ids.length });
});
