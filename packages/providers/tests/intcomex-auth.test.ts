import { describe, expect, it } from 'vitest';
import {
  buildAuthToken,
  buildSignature,
  formatUtcTimestamp,
} from '@rr/providers/intcomex';

describe('formatUtcTimestamp', () => {
  it('formats as YYYY-MM-DDTHH:mm:ssZ without milliseconds', () => {
    const date = new Date('2020-01-20T15:10:00.123Z');
    expect(formatUtcTimestamp(date)).toBe('2020-01-20T15:10:00Z');
  });
});

describe('buildSignature', () => {
  it('returns SHA-256 hex of "apiKey,accessKey,timestamp"', () => {
    const signature = buildSignature('myApiKey', 'myAccessKey', '2020-01-20T15:10:00Z');
    expect(signature).toBe(
      'd6364b68908f32c6da6f7fae1a35a8259c886d764701825cca7bc0188d07033d',
    );
  });
});

describe('buildAuthToken', () => {
  it('assembles apiKey, timestamp and signature', () => {
    const token = buildAuthToken('myApiKey', 'myAccessKey', new Date('2020-01-20T15:10:00.000Z'));
    expect(token).toBe(
      'apiKey=myApiKey&utcTimeStamp=2020-01-20T15:10:00Z&signature=d6364b68908f32c6da6f7fae1a35a8259c886d764701825cca7bc0188d07033d',
    );
  });
});
