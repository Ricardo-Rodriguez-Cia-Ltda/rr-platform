import { createHash } from 'node:crypto';

export function formatUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildSignature(
  apiKey: string,
  accessKey: string,
  utcTimeStamp: string,
): string {
  return createHash('sha256')
    .update(`${apiKey},${accessKey},${utcTimeStamp}`)
    .digest('hex');
}

export function buildAuthToken(apiKey: string, accessKey: string, now: Date): string {
  const utcTimeStamp = formatUtcTimestamp(now);
  const signature = buildSignature(apiKey, accessKey, utcTimeStamp);
  return `apiKey=${apiKey}&utcTimeStamp=${utcTimeStamp}&signature=${signature}`;
}
