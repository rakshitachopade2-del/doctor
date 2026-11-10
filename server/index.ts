import { createApp } from './app.ts';
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const app = createApp();
const server = app.listen(port, host, () =>
  console.log(`Derma Studio API ready at http://${host}:${port}`),
);
function shutdown() {
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
