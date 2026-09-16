import type { Metadata } from 'next';
import { Resumen } from './Resumen.js';

export const metadata: Metadata = { title: 'Tu pedido — Dr. Computación', robots: { index: false } };

export default async function Pedido({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Resumen quoteId={id} />;
}
