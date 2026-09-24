// Supabase Storage por su API REST, sin SDK, igual que el resto del repo habla
// con Supabase (apps/mailer/src/pago/datos.ts). Bucket publico de lectura: la
// tienda enlaza las fotos directo.

export interface StorageFotos {
  asegurarBucket(): Promise<void>;
  subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

const TIMEOUT_MS = 30000;
// Una subida lenta o un 5xx pasajero no deben cortar una corrida de horas:
// 3 intentos en total. x-upsert hace que reintentar sea idempotente.
const ESPERAS_MS = [1000, 3000];

function esperaReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function crearStorage(cfg: {
  url: string; key: string; bucket?: string; fetchImpl?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
}): StorageFotos {
  const base = cfg.url.replace(/\/+$/, '');
  const bucket = cfg.bucket ?? 'fotos-productos';
  const f = cfg.fetchImpl ?? fetch;
  const esperar = cfg.esperar ?? esperaReal;
  const auth = { authorization: `Bearer ${cfg.key}`, apikey: cfg.key };

  return {
    async asegurarBucket() {
      const res = await f(`${base}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
      const texto = await res.text().catch(() => '');
      // Supabase responde 409 (o 400 con "already exists") si ya existe.
      if (res.status === 409 || /already exists|duplicate/i.test(texto)) return;
      throw new Error(`Supabase Storage respondio HTTP ${res.status} al crear el bucket: ${texto.slice(0, 200)}`);
    },

    async subir(ruta, bytes, contentType) {
      for (let intento = 0; ; intento += 1) {
        const ultimo = intento >= ESPERAS_MS.length;
        let res: Response;
        try {
          res = await f(`${base}/storage/v1/object/${bucket}/${ruta}`, {
            method: 'POST',
            headers: {
              ...auth, 'content-type': contentType, 'x-upsert': 'true',
              // Las fotos no cambian en esta fase: cache largo en la CDN.
              'cache-control': 'max-age=31536000',
            },
            body: bytes,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (error) {
          // Error de red o timeout: se reintenta.
          if (ultimo) {
            const causa = error instanceof Error ? error.message : String(error);
            throw new Error(`Supabase Storage no respondio al subir ${ruta}: ${causa}`);
          }
          await esperar(ESPERAS_MS[intento]!);
          continue;
        }
        if (res.ok) return `${base}/storage/v1/object/public/${bucket}/${ruta}`;
        const reintentable = res.status >= 500 || res.status === 429;
        if (reintentable && !ultimo) {
          await res.text().catch(() => '');
          await esperar(ESPERAS_MS[intento]!);
          continue;
        }
        const texto = await res.text().catch(() => '');
        throw new Error(`Supabase Storage respondio HTTP ${res.status} al subir ${ruta}: ${texto.slice(0, 200)}`);
      }
    },
  };
}
