import { intcomex } from '@rr/providers/intcomex';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: npm run check -- <SKU>  |  mpn:<MPN>  |  upc:<UPC>');
  process.exit(1);
}

const query = raw.startsWith('mpn:')
  ? { mpn: raw.slice(4) }
  : raw.startsWith('upc:')
    ? { upc: raw.slice(4) }
    : { sku: raw };

try {
  const result = await intcomex.getPrecio(query);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('FAILED:', error);
  process.exit(1);
}
