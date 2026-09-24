// Supabase Storage por su API REST, sin SDK, igual que el resto del repo habla
// con Supabase (apps/mailer/src/pago/datos.ts). Bucket publico de lectura: la
// tienda enlaza las fotos directo.

export interface StorageFotos {
  asegurarBucket(): Promise<void>;
  subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

const TIMEOUT_MS = 30000;

export function crearStorage(cfg: {
  url: string; key: string; bucket?: string; fetchImpl?: typeof fetch;
}): StorageFotos {
  const base = cfg.url.replace(/\/+$/, '');
  const bucket = cfg.bucket ?? 'fotos-productos';
  const f = cfg.fetchImpl ?? fetch;
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
      const res = await f(`${base}/storage/v1/object/${bucket}/${ruta}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' },
        body: bytes,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`Supabase Storage respondio HTTP ${res.status} al subir ${ruta}: ${texto.slice(0, 200)}`);
      }
      return `${base}/storage/v1/object/public/${bucket}/${ruta}`;
    },
  };
}
