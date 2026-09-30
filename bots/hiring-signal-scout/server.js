import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

import http from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { verifySlackSignature, parseInteraction, handleInteraction, createTransport } from './approvals.js';

/**
 * Long-running endpoint for Slack button clicks. Point your Slack app's
 * Interactivity "Request URL" at https://<public host>/slack/actions.
 * Slack needs an answer within 3 seconds, so we acknowledge immediately and
 * do the work (send, update message) afterwards.
 */
const MAX_BODY_BYTES = 1_000_000;

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

const cfg = loadConfig();
if (!cfg.slackSigningSecret) {
  log.error('SLACK_SIGNING_SECRET is required; refusing to start without request verification');
  process.exit(1);
}
const transport = createTransport(cfg);
const db = openDb(cfg.dbPath);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/slack/actions') {
    res.writeHead(404).end();
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }

  const verified = verifySlackSignature({
    signingSecret: cfg.slackSigningSecret,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody,
  });
  if (!verified) {
    log.warn('Rejected request with invalid Slack signature');
    res.writeHead(401).end();
    return;
  }

  let payload;
  try {
    payload = parseInteraction(rawBody);
  } catch (err) {
    res.writeHead(400).end();
    return;
  }

  res.writeHead(200).end(); // ack within Slack's 3-second window
  handleInteraction(db, payload, { cfg, transport, log })
    .then((r) => log.info(`Interaction ${r.outcome}${r.proposalId ? ` (proposal ${r.proposalId})` : ''}`))
    .catch((err) => log.error(`Interaction failed: ${err.stack ?? err.message}`));
});

server.listen(cfg.approvalsPort, () => {
  log.info(`Approvals listening on :${cfg.approvalsPort} (transport: ${transport.name})`);
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);