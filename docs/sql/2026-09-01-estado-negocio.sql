-- Estado de NEGOCIO del pedido (spec 2026-09-01-backoffice), separado del
-- estado tecnico del correo (`estado`). Filas existentes nacen 'nuevo'.
alter table pedidos add column if not exists estado_negocio text not null default 'nuevo'
  check (estado_negocio in ('nuevo','pagado','entregado','anulado'));
alter table pedidos add column if not exists pagado_at timestamptz;
alter table pedidos add column if not exists entregado_at timestamptz;
