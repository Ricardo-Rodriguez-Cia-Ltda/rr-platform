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

export interface Provider {
  name: string;
  getPrice(query: PriceQuery): Promise<PriceResult>;
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
