# <nombre del agente> — v-NN

| | |
|---|---|
| **Nodo Kapso** | `agent_xx` |
| **Estado** | borrador |
| **Fecha** | AAAA-MM-DD |
| **Reemplaza a** | v-NN anterior, o `—` |
| **Lee** | `variable_a`, `variable_b` |
| **Escribe** | `variable_c` |
| **Tools** | las que tenga habilitadas, o `—` |
| **Siguiente nodo** | `nombre-del-nodo` |

## Qué cambió

Respecto de la versión anterior, y **por qué**. Un cambio sin motivo escrito no
se puede revertir con criterio dentro de seis meses.

1. …

## Prompt

<!-- PROMPT:INICIO -->

Texto exacto que va en `system_prompt` del nodo. Nada de este archivo fuera de
los delimitadores llega al modelo.

<!-- PROMPT:FIN -->

## Notas de diseño

Decisiones que no son obvias leyendo el prompt: qué se probó y no funcionó, qué
restricción de la API o del workflow obliga a una regla concreta, qué queda
pendiente.
