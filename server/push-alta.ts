// Revo Pádel · activar o quitar las notificaciones en el móvil
// Cuerpo: { action: "clave" }                         → clave pública para suscribirse
//         { action: "alta", subscription }            → guarda la suscripción de este móvil
//         { action: "baja", endpoint }                → la quita
//         { action: "prueba" }                        → manda una notificación de prueba a mis móviles
import { admin, currentUser, handle, json, sendPush, UserError, vapid, APP_URL } from "./revo.ts";

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const sb = admin();
  const action = String(body.action ?? "");

  if (action === "clave") return json({ publicKey: (await vapid(sb)).publicKey });

  if (action === "alta") {
    const s = body.subscription ?? {};
    const endpoint = String(s.endpoint ?? ""), p256dh = String(s.keys?.p256dh ?? ""), auth = String(s.keys?.auth ?? "");
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
      throw new UserError("Suscripción no válida");
    }
    const { error } = await sb.from("push_subscriptions").upsert({ user_id: user.id, endpoint, p256dh, auth }, { onConflict: "endpoint" });
    if (error) throw error;
    return json({ ok: true });
  }

  if (action === "baja") {
    const endpoint = String(body.endpoint ?? "");
    await sb.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", user.id);
    return json({ ok: true });
  }

  if (action === "prueba") {
    const n = await sendPush(sb, user.id, { title: "¡Avisos activados!", body: "Así te avisaremos de tus reservas y partidos.", url: APP_URL });
    return json({ ok: true, enviadas: n });
  }

  throw new UserError("Acción no válida");
}));
