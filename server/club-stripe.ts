// Revo Pádel · cobros del club (solo administradores del club)
// Cada club cobra en SU cuenta de Stripe: pega aquí su clave y el dinero de las reservas le llega directo.
// Cuerpo: { club_id, action }
//   estado            → cómo están los cobros del club
//   guardar { key }   → comprueba la clave con Stripe, la guarda cifrada y da de alta el aviso de pagos
//   quitar            → borra la clave del club
// La clave nunca se devuelve ni se escribe en los registros.
import {
  admin, clubStripeOrNull, currentUser, ensureWebhook, handle, json, KEY_RE, livePaymentsAllowed, stripeFromKey, UserError,
} from "./revo.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

async function estado(sb: SupabaseClient, clubId: string) {
  const { data: row } = await sb.from("club_stripe").select("key_hint, livemode, account_name, webhook_secret, updated_at").eq("club_id", clubId).maybeSingle();
  const propia = !!row?.key_hint;
  const cs = await clubStripeOrNull(sb, clubId);
  return {
    modo: propia ? "propia" : cs ? "compartida" : "ninguna",   // compartida = clave de prueba de Revo, solo para probar
    cobra: !!cs,
    real: propia && !!row?.livemode,
    clave: row?.key_hint ?? null,
    cuenta: row?.account_name ?? null,
    aviso: !!row?.webhook_secret,
    reales_permitidos: livePaymentsAllowed(),
    desde: propia ? row?.updated_at : null,
  };
}

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.club_id ?? "");
  const action = String(body.action ?? "estado");

  const sb = admin();
  const { data: adm } = await sb.from("club_admins").select("user_id").eq("club_id", clubId).eq("user_id", user.id).maybeSingle();
  if (!adm) throw new UserError("Solo el club puede hacer esto");

  if (action === "guardar") {
    const key = String(body.key ?? "").trim();
    if (!KEY_RE.test(key)) throw new UserError("Eso no parece una clave secreta de Stripe. Empieza por sk_ o rk_ (la que empieza por pk_ no vale).");
    const live = /^(sk|rk)_live_/.test(key);
    if (live && !livePaymentsAllowed()) throw new UserError("Los pagos reales todavía no están activados en Revo. De momento usa una clave de prueba (sk_test_…).");
    const st = stripeFromKey(key);
    // Comprobaciones: que la clave funciona y que deja crear pagos y devoluciones
    try {
      await st.checkout.sessions.list({ limit: 1 });
      await st.refunds.list({ limit: 1 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 401) throw new UserError("Stripe no reconoce esa clave. Cópiala entera desde tu panel de Stripe.");
      if (code === 403) throw new UserError("A esa clave le faltan permisos. Necesita poder escribir en «Checkout Sessions» y «Refunds».");
      throw new UserError("No se ha podido comprobar la clave con Stripe. Inténtalo de nuevo en un momento.");
    }
    let name: string | null = null;
    try {
      const acct = await st.accounts.retrieve();
      name = (acct.business_profile?.name || acct.settings?.dashboard?.display_name || acct.email || null)?.slice(0, 80) ?? null;
    } catch (_e) { /* una clave restringida puede no dejar leer la cuenta: no pasa nada */ }
    const hint = key.slice(0, 8) + "…" + key.slice(-4);
    const { error } = await sb.rpc("club_stripe_set_key", { p_club: clubId, p_key: key, p_hint: hint, p_live: live, p_name: name, p_user: user.id });
    if (error) throw error;
    let aviso = true;
    try { await ensureWebhook(st, sb, clubId); } catch (e) { aviso = false; console.error("webhook", clubId, String(e).slice(0, 200)); }
    return json({ ...(await estado(sb, clubId)), guardada: true, aviso });
  }

  if (action === "quitar") {
    const cs = await clubStripeOrNull(sb, clubId);
    const { data: row } = await sb.from("club_stripe").select("key_hint, webhook_id").eq("club_id", clubId).maybeSingle();
    if (!row?.key_hint) throw new UserError("Este club no tiene ninguna clave guardada");
    const { count } = await sb.from("payments").select("id, bookings!inner(club_id)", { count: "exact", head: true })
      .eq("bookings.club_id", clubId).eq("status", "pending");
    if ((count ?? 0) > 0) throw new UserError("Hay pagos a medias ahora mismo. Espera unos minutos y vuelve a intentarlo.");
    if (cs?.own && row.webhook_id) { try { await cs.st.webhookEndpoints.del(row.webhook_id); } catch (_e) { /* ya no existe */ } }
    const { error } = await sb.rpc("club_stripe_clear_key", { p_club: clubId, p_user: user.id });
    if (error) throw error;
    return json({ ...(await estado(sb, clubId)), quitada: true });
  }

  return json(await estado(sb, clubId));
}));
