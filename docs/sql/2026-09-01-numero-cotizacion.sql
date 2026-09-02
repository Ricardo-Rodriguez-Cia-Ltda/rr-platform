-- Numero correlativo de cotizacion (spec 2026-09-01). Se ejecuta UNA vez en el
-- SQL Editor de Supabase. Arranca en 1.600.001 para quedar por sobre la
-- numeracion historica en papel (~1.53M); ajustar el start ANTES de pegar si
-- se quiere otro punto de partida.
alter table cotizaciones
  add column if not exists numero bigint generated always as identity (start with 1600001);
