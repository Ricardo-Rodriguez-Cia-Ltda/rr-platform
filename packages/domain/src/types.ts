import type { NormalizedProduct } from './product.js';

export interface PriceQuery {
  sku?: string;
  mpn?: string;
  upc?: string;
}

export interface PriceResult {
  provider: string;
  sku: string | null;
  mpn: string | null;
  description: string | null;
  price: number;
  currency: string;
  inStock: number | null;
}

export interface PriceInfo {
  price: number;
  currency: string;
  inStock: number | null;
}

export interface Provider {
  nombre: string;
  loadCatalog(): Promise<NormalizedProduct[]>;
  getPrecios(skus: string[]): Promise<Map<string, PriceInfo>>;
  getPrecio(query: PriceQuery): Promise<PriceResult>;
  /** Tope de SKUs por llamada de precios. Es limite del proveedor, no politica nuestra. */
  maxSkusPorLote: number;
  isConfigured(): boolean;
}

export type ProviderErrorKind = 'not_found' | 'upstream';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
