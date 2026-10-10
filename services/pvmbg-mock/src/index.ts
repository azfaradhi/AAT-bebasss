import { buildApp } from './app';
import { loadConfig } from './config';
import { addLiveReport, createPvmbgState } from './data';

const config = loadConfig(process.env);
const state = createPvmbgState();
const app = buildApp({ config, state });

setInterval(() => addLiveReport(state), 10_000);

app.listen({ port: config.PVMBG_PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`pvmbg-mock listening on ${address}`);
});
