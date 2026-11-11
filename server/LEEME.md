# Código del servidor de Revo Pádel

Estas son las funciones que corren en Supabase (Edge Functions). No contienen ninguna clave:
las claves viven en los secretos de Supabase y, las de Stripe de cada club, cifradas en la base de datos.

Cada función desplegada en Supabase es una línea que importa su archivo de aquí, fijado a un commit concreto,
así que cambiar estos archivos no cambia nada en producción hasta que se vuelve a desplegar.
