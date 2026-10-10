import { buildApp } from './app';
import { loadConfig } from './config';
import { addLiveRecord, createBmkgState } from './data';

const config = loadConfig(process.env);
const state = createBmkgState();
const app = buildApp({ config, state });

setInterval(() => addLiveRecord(state), 10_000);

app.listen({ port: config.BMKG_PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`bmkg-mock listening on ${address}`);
});
