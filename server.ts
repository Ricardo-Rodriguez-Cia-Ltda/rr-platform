import { createApp } from './lib/server.js';

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`price-fetcher API listening on http://${host}:${port}`);
});
