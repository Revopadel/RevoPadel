// Revo Pádel · al volver de la página de pago, comprueba con Stripe si el pago se completó
// Cuerpo: { booking_id }
import { admin, currentUser, handle, json, syncPending, UserError } from "./revo.ts";

Deno.serve((req) => handle(req, async () => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const user = await currentUser(req);
  if (!user) return json({ error: "Tienes que iniciar sesión" }, 401);
  const body = await req.json().catch(() => ({}));
  const bookingId = String(body.booking_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) throw new UserError("Reserva no válida");
  const sb = admin();
  const resultados = await syncPending(sb, { bookingId, userId: user.id });
  const { data: b } = await sb.from("bookings").select("status, payment_state").eq("id", bookingId).maybeSingle();
  return json({ resultados, reserva: b?.status ?? null, estado_pago: b?.payment_state ?? null });
}));
