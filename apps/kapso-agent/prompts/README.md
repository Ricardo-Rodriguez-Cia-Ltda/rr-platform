# Prompts de los agentes — workflow `rr-isia-version2`

Un directorio por nodo `agent`, una versión por archivo. El texto que se
despliega vive entre `<!-- PROMPT:INICIO -->` y `<!-- PROMPT:FIN -->`; todo lo
demás es documentación para nosotros. `scripts/deploy-workflow.ts` sube
**solo ese bloque** — el error de v1, donde se pegó el archivo entero, no se
repite.

**Diseño:** [`../../../docs/superpowers/specs/2026-08-26-rr-isia-version2-design.md`](../../../docs/superpowers/specs/2026-08-26-rr-isia-version2-design.md)

## Índice

| Directorio | Nodo | Responsabilidad | Vigente |
|---|---|---|---|
| [`agente-descubrimiento/`](agente-descubrimiento/) | `agente_descubrimiento` | Entiende la necesidad, busca y arma el carro | v-05 |
| [`agente-presentacion/`](agente-presentacion/) | `agente_presentacion` | Presenta la cotización y captura la decisión | v-02 |
| [`agente-facturacion/`](agente-facturacion/) | `agente_facturacion` | RUT y datos tributarios, en bloque | v-03 |
| [`agente-cierre/`](agente-cierre/) | `agente_cierre` | Confirmación final antes de emitir las órdenes | v-01 |

## Qué cambia respecto de v1

- No hay nodo de recuperación de rechazo: `rejected` vuelve a descubrimiento.
- No hay método de pago: siempre contado.
- El carro debe llevar `mpn` y `marca`, no solo `sku`. Sin MPN no hay comparación entre mayoristas.
- Ningún agente puede nombrar al mayorista frente al cliente.
