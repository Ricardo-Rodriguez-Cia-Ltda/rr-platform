-- Persistencia de clientes, cotizaciones y pedidos (spec 2026-08-31).
-- Se ejecuta UNA vez en el SQL Editor de Supabase. Idempotente.

create table if not exists clientes (
  telefono      text primary key,
  rut           text not null,
  razon_social  text not null,
  giro          text not null,
  direccion     text not null,
  comuna        text not null,
  ciudad        text not null,
  email         text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists cotizaciones (
  quote_id      text not null,
  version       text not null,
  telefono      text,
  neto_clp      bigint not null,
  iva_clp       bigint not null,
  total_clp     bigint not null,
  valida_hasta  timestamptz,
  lineas        jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (quote_id, version)
);

create table if not exists pedidos (
  po_id           text primary key,
  quote_id        text not null,
  quote_version   text not null,
  proveedor       text not null,
  telefono        text,
  rut             text,
  razon_social    text,
  lineas          jsonb not null,
  neto_grupo_clp  bigint,
  estado          text not null,
  email_id        text,
  created_at      timestamptz not null default now()
);
