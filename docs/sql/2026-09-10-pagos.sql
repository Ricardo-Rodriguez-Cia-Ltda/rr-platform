-- Pagos con Mercado Pago (spec 2026-09-10). Se ejecuta UNA vez en el SQL
-- Editor de Supabase. Idempotente.

-- `quote_id` es la llave: un intento de cobro por cotizacion. Eso da la
-- idempotencia de `POST /api/pago/crear` -- una segunda llamada por la misma
-- cotizacion devuelve el link que ya existe en vez de crear otra preferencia.
create table if not exists pagos (
  quote_id            text primary key,
  quote_version       text not null,
  numero              bigint,
  telefono            text,
  phone_number_id     text,
  preference_id       text not null,
  init_point          text not null,
  monto_clp           bigint not null,
  expira_at           timestamptz not null,
  -- Un pago rechazado NO es un estado: una tarjeta rechazada seguida de un
  -- segundo intento exitoso es comun, y un estado terminal haria fallar la
  -- transicion condicional a 'aprobado' justo en el intento bueno.
  estado              text not null default 'pendiente'
    check (estado in ('pendiente','aprobado','emitido','aprobado_sin_emitir')),
  mp_payment_id       text,
  intentos_rechazados int not null default 0,
  -- quote_customer_name y los siete billing_*: lo que emitir-ordenes-compra
  -- espera en `vars` y no vive en ninguna otra tabla.
  datos               jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  aprobado_at         timestamptz,
  emitido_at          timestamptz
);

-- RLS sin policies, igual que las otras tres tablas: el unico acceso legitimo
-- es la service_role, que bypasea RLS por definicion.
alter table pagos enable row level security;

-- El quinto campo que emitir-ordenes-compra lee de la cotizacion y que hasta
-- hoy no se guardaba. Sin el, el correo de la orden pierde el aviso "al
-- cotizar no respondieron X".
alter table cotizaciones add column if not exists proveedores_incompletos jsonb;
