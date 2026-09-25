-- Modulo de compras y despachos (spec 2026-09-25-despachos-design).
-- Se aplica a mano en el SQL Editor de Supabase. Es idempotente: se puede
-- correr dos veces sin romper nada.

-- 1. Compras: estado de abastecimiento por orden de compra (fila de pedidos).
alter table pedidos add column if not exists estado_compra text not null default 'por_comprar'
  check (estado_compra in ('por_comprar','comprada','por_retirar','en_camino','directo_al_cliente',
                           'recibida_parcial','recibida','entregada_al_cliente','anulada'));
alter table pedidos add column if not exists modalidad_compra text
  check (modalidad_compra in ('retiro','despacho_mayorista','directo_cliente'));
alter table pedidos add column if not exists numero_pedido_mayorista text;
alter table pedidos add column if not exists comprada_at timestamptz;
alter table pedidos add column if not exists llegada_estimada date;
alter table pedidos add column if not exists guia_mayorista text;
alter table pedidos add column if not exists nota_compra text;

-- Relleno inicial: lo ya entregado o anulado no aparece como compra pendiente.
update pedidos set estado_compra = 'recibida'
  where estado_negocio = 'entregado' and estado_compra = 'por_comprar';
update pedidos set estado_compra = 'anulada'
  where estado_negocio = 'anulado' and estado_compra = 'por_comprar';

-- 2. Recepciones: lo que llego de cada linea de una orden de compra.
create table if not exists recepciones (
  id bigint generated always as identity primary key,
  po_id text not null references pedidos(po_id),
  mpn text not null,
  cantidad int not null check (cantidad > 0),
  recibido_at timestamptz not null default now(),
  nota text
);
create index if not exists recepciones_po_id on recepciones(po_id);
alter table recepciones enable row level security;

-- 3. Despachos al cliente. El id es tambien el numero visible del despacho.
create table if not exists despachos (
  id bigint generated always as identity primary key,
  quote_id text not null,
  quote_version text not null,
  modalidad text not null check (modalidad in ('retiro_oficina','propio','courier')),
  courier text check (courier in ('bluexpress','starken','chilexpress','otro')),
  estado text not null default 'por_preparar'
    check (estado in ('por_preparar','listo','en_ruta','entregado','fallido','anulado')),
  direccion text, comuna text, ciudad text,
  contacto_nombre text, contacto_telefono text,
  fecha_programada date,
  responsable text,
  numero_seguimiento text,
  costo_clp int check (costo_clp >= 0),
  cobrado_clp int check (cobrado_clp >= 0),
  cobro_pagado boolean not null default false,
  nota text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  despachado_at timestamptz,
  entregado_at timestamptz
);
create index if not exists despachos_pedido on despachos(quote_id, quote_version);
alter table despachos enable row level security;

create table if not exists despacho_lineas (
  id bigint generated always as identity primary key,
  despacho_id bigint not null references despachos(id) on delete cascade,
  po_id text not null references pedidos(po_id),
  mpn text not null,
  cantidad int not null check (cantidad > 0)
);
create index if not exists despacho_lineas_despacho on despacho_lineas(despacho_id);
alter table despacho_lineas enable row level security;

create table if not exists despacho_eventos (
  id bigint generated always as identity primary key,
  despacho_id bigint not null references despachos(id) on delete cascade,
  desde text,
  hacia text not null,
  nota text,
  created_at timestamptz not null default now()
);
create index if not exists despacho_eventos_despacho on despacho_eventos(despacho_id);
alter table despacho_eventos enable row level security;

-- 4. Crear un despacho con sus lineas y su primer evento en una sola
-- transaccion: si algo falla, no queda un despacho sin lineas.
create or replace function crear_despacho(p_despacho jsonb, p_lineas jsonb)
returns despachos language plpgsql as $$
declare
  d despachos;
begin
  insert into despachos (
    quote_id, quote_version, modalidad, courier, direccion, comuna, ciudad,
    contacto_nombre, contacto_telefono, fecha_programada, responsable,
    costo_clp, cobrado_clp, nota
  ) values (
    p_despacho->>'quote_id', p_despacho->>'quote_version', p_despacho->>'modalidad',
    nullif(p_despacho->>'courier', ''),
    nullif(p_despacho->>'direccion', ''), nullif(p_despacho->>'comuna', ''), nullif(p_despacho->>'ciudad', ''),
    nullif(p_despacho->>'contacto_nombre', ''), nullif(p_despacho->>'contacto_telefono', ''),
    nullif(p_despacho->>'fecha_programada', '')::date,
    nullif(p_despacho->>'responsable', ''),
    nullif(p_despacho->>'costo_clp', '')::int, nullif(p_despacho->>'cobrado_clp', '')::int,
    nullif(p_despacho->>'nota', '')
  ) returning * into d;

  insert into despacho_lineas (despacho_id, po_id, mpn, cantidad)
  select d.id, l->>'po_id', l->>'mpn', (l->>'cantidad')::int
  from jsonb_array_elements(p_lineas) as l;

  insert into despacho_eventos (despacho_id, desde, hacia, nota)
  values (d.id, null, 'por_preparar', 'creado');

  return d;
end;
$$;
