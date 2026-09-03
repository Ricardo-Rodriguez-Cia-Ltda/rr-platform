import type { Metadata } from 'next';
import { Checkout } from './Checkout.js';

export const metadata: Metadata = { title: 'Tu carro — Dr. Computación', robots: { index: false } };

export default function Carro() {
  return <Checkout />;
}
