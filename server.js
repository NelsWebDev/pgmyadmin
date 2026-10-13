const path = require('path');
const express = require('express');
const config = require('./src/config');
const api = require('./src/api');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: config.uploadLimit }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

// State-changing requests must carry a custom header, which cross-site forms cannot send.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-pgm-request'] !== '1') {
    return res.status(403).json({ error: 'Missing X-PGM-Request header' });
  }
  next();
});
app.use('/api', api);
app.use((err, req, res, next) => {
  res.status(err.status || 400).json({ error: err.message });
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const { listenHost: host, listenPort: port } = config;
  app.listen(port, host, () => {
    console.log(`pgMyAdmin listening on http://${host}:${port}`);
    console.log(config.envFile ? `Configuration loaded from ${config.envFile}` : 'No .env file found; using environment variables and defaults');
    if (config.authType === 'config' && !/^(127\.|localhost$|::1$)/.test(host)) {
      console.warn(`WARNING: auth is "config" (everyone is logged in as ${config.user}) and the server listens on ${host}. Put it behind authentication.`);
    }
  });
}

module.exports = app;
