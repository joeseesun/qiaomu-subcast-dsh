import { createApp } from './app.js';
import { loadConfig, VERSION } from './config.js';

const config = loadConfig(process.env);
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  const { address, port } = app.server.address();
  const host = address.includes(':') ? `[${address}]` : address;
  process.stdout.write(`subcast-api ${VERSION} listening on http://${host}:${port} data=${config.dataDir} admin=${config.adminToken ? 'on' : 'off'}\n`);
});

app.server.on('error', (err) => {
  process.stderr.write(`server error: ${err.message}\n`);
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    process.stdout.write(`${sig} received, shutting down\n`);
    await app.close();
    process.stdout.write('shutdown complete\n');
    process.exit(0);
  });
}
