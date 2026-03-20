const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const path = require('path');

const settings = require('./settings');
const createLogger = require('../lib/logger');

const logger = createLogger('sync-server', { level: settings.logLevel });
const port = settings.port;
const shares = settings.shares;

const suppressedEvents = new Map();

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

function suppressEvent(shareName, relPath) {
  const key = `${shareName}:${relPath}`;
  suppressedEvents.set(key, Date.now());
  setTimeout(() => suppressedEvents.delete(key), 500);
}

function isSuppressed(shareName, relPath) {
  const key = `${shareName}:${relPath}`;
  return suppressedEvents.has(key);
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(payload);
  } catch (err) {
    logger.warn('failed to send payload', err.message);
  }
}

function sendToShareClients(msg, { exclude } = {}) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client === exclude) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.shareName !== msg.share) continue;
    safeSend(client, payload);
  }
}

async function collectSnapshot(share) {
  const directories = [];
  const files = [];

  async function walk(current) {
    const entries = await fs.readdir(current);
    for (const entry of entries) {
      const absolute = path.join(current, entry);
      const stats = await fs.stat(absolute);
      const rel = normalizeRelPath(path.relative(share.path, absolute));
      if (stats.isDirectory()) {
        directories.push(rel);
        await walk(absolute);
      } else if (stats.isFile()) {
        const content = await fs.readFile(absolute);
        files.push({
          path: rel,
          encoding: 'base64',
          content: content.toString('base64')
        });
      }
    }
  }

  await walk(share.path);
  return { directories, files };
}

async function sendSnapshot(ws, share) {
  try {
    const snapshot = await collectSnapshot(share);
    safeSend(ws, JSON.stringify({
      type: 'snapshot',
      share: share.name,
      snapshot
    }));
    logger.info('sent snapshot', { share: share.name, files: snapshot.files.length });
  } catch (err) {
    logger.error('failed to send snapshot', { share: share.name, err: err.message });
  }
}

function handleFsEvent(share, absolutePath, action, includeContent) {
  const relPath = normalizeRelPath(path.relative(share.path, absolutePath));
  if (!relPath) return;
  if (isSuppressed(share.name, relPath)) return;

  const msg = {
    type: 'file-change',
    share: share.name,
    action,
    path: relPath
  };

  if (includeContent) {
    try {
      msg.encoding = 'base64';
      msg.content = fs.readFileSync(absolutePath).toString('base64');
    } catch (err) {
      logger.warn('failed to read change content', err.message);
      return;
    }
  }

  logger.info('share filesystem change', { share: share.name, action, path: relPath });
  sendToShareClients(msg);
}

function registerWatchers() {
  const watchOptions = { persistent: true, ignoreInitial: true };
  for (const share of shares) {
    fs.ensureDirSync(share.path);
    logger.info('watching share', { name: share.name, path: share.path });
    const watcher = chokidar.watch(share.path, watchOptions);
    watcher.on('add', (p) => handleFsEvent(share, p, 'update', true));
    watcher.on('change', (p) => handleFsEvent(share, p, 'update', true));
    watcher.on('unlink', (p) => handleFsEvent(share, p, 'delete'));
    watcher.on('addDir', (p) => handleFsEvent(share, p, 'ensureDir'));
    watcher.on('unlinkDir', (p) => handleFsEvent(share, p, 'delete'));
    watcher.on('error', (err) => logger.error('watcher error', { share: share.name, err: err.message }));
  }
}

const wss = new WebSocket.Server({ host: '0.0.0.0', port });

wss.on('listening', () => {
  logger.info('sync server listening', { port });
});

wss.on('connection', (ws) => {
  logger.info('client connected');
  ws.send(JSON.stringify({ type: 'share-list', shares: shares.map((s) => ({ name: s.name })) }));

  ws.on('message', async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      logger.warn('invalid payload', err.message);
      return;
    }

    if (payload.type === 'init') {
      const share = shares.find((s) => s.name === payload.share);
      if (!share) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Unknown share' }));
        return;
      }
      ws.shareName = share.name;
      await sendSnapshot(ws, share);
      return;
    }

    if (payload.type === 'file-change') {
      const share = shares.find((s) => s.name === payload.share || ws.shareName);
      if (!share) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Unknown share for change' }));
        return;
      }
      const targetPath = path.join(share.path, payload.path);
      try {
        if (payload.action === 'ensureDir') {
          await fs.ensureDir(targetPath);
        } else if (payload.action === 'update') {
          await fs.ensureDir(path.dirname(targetPath));
          const buffer = Buffer.from(payload.content || '', payload.encoding || 'base64');
          await fs.writeFile(targetPath, buffer);
        } else if (payload.action === 'delete') {
          await fs.remove(targetPath);
        }
      } catch (err) {
        logger.error('failed to apply client change', err.message);
        return;
      }
      suppressEvent(share.name, payload.path);
      logger.info('applied client change', { share: share.name, action: payload.action, path: payload.path });
      sendToShareClients(payload, { exclude: ws });
    }
  });

  ws.on('close', () => {
    logger.info('client disconnected');
  });
});

registerWatchers();

process.on('uncaughtException', (err) => logger.error('uncaught exception', err.stack || err.message));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));
