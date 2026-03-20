const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const readline = require('readline');
const yargs = require('yargs/yargs');

const settings = require('./settings');
const createLogger = require('../lib/logger');

const argv = yargs(process.argv.slice(2))
  .option('log-level', { type: 'string', choices: ['debug', 'info', 'warn', 'error'], default: settings.logLevel })
  .option('choose-local', {
    type: 'boolean',
    describe: 'Prompt for the local mirror location before syncing',
    default: false
  })
  .help(false)
  .parse();

const serverUrl = process.env.SYNC_SERVER_URL || settings.server;
const shareName = process.env.SYNC_SHARE || settings.share;
const envLocal = process.env.SYNC_LOCAL_DIR;

function expandTilde(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  const prefix = `~${path.sep}`;
  if (value.startsWith(prefix)) {
    return path.join(os.homedir(), value.slice(prefix.length));
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function computeDefaultLocal(name) {
  const override = settings.sharePaths?.[name];
  const base = override || settings.local;
  const candidate = expandTilde(envLocal || base);
  return path.resolve(process.cwd(), candidate || '');
}
let localDir = computeDefaultLocal(shareName);
const logger = createLogger('sync-client', { level: argv['log-level'] });

let localWatcher;
const suppressed = new Map();
let ws;
let initSent = false;
let reconnectTimeout;
let shuttingDown = false;

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

function suppressEvent(relPath) {
  const key = relPath || '.';
  suppressed.set(key, Date.now());
  setTimeout(() => suppressed.delete(key), 500);
}

function isSuppressed(relPath) {
  const key = relPath || '.';
  return suppressed.has(key);
}

function askQuestion(promptText, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue ? `${promptText} [${defaultValue}]: ` : `${promptText}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function chooseLocalDir() {
  if (!argv['choose-local']) return;
  const answer = await askQuestion('Local folder to mirror the share', localDir);
  if (answer.trim()) {
    localDir = path.resolve(process.cwd(), answer.trim());
  }
}

function startLocalWatcher() {
  if (localWatcher) {
    localWatcher.close();
  }
  const options = { persistent: true, ignoreInitial: true };
  localWatcher = chokidar.watch(localDir, options);
  const forward = (action, absolute, includeContent) => {
    handleLocalChange(action, absolute, includeContent).catch((err) => {
      logger.error('fwd local change failed', err.message);
    });
  };
  localWatcher.on('add', (p) => forward('update', p, true));
  localWatcher.on('change', (p) => forward('update', p, true));
  localWatcher.on('unlink', (p) => forward('delete', p, false));
  localWatcher.on('addDir', (p) => forward('ensureDir', p, false));
  localWatcher.on('unlinkDir', (p) => forward('delete', p, false));
  localWatcher.on('error', (err) => logger.error('watcher error', err.message));
}

async function handleLocalChange(action, absolutePath, includeContent) {
  const relPath = normalizeRelPath(path.relative(localDir, absolutePath));
  if (!relPath) return;
  if (isSuppressed(relPath)) {
    logger.debug('ignored suppressed local event', { path: relPath, action });
    return;
  }
  logger.info('local filesystem change', { action, path: relPath });
  if (action === 'update' && includeContent) {
    const data = await fs.readFile(absolutePath);
    sendFileChange({ action, path: relPath, encoding: 'base64', content: data.toString('base64') });
  } else {
    sendFileChange({ action, path: relPath });
  }
}

function sendFileChange(change) {
  if (ws.readyState !== WebSocket.OPEN) {
    logger.warn('WS not open to send local change', change);
    return;
  }
  ws.send(JSON.stringify({ type: 'file-change', share: shareName, ...change }));
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    logger.info('reconnecting to sync server', { delay: settings.reconnectDelayMs });
    connectWebSocket();
  }, settings.reconnectDelayMs);
}

function requestInit() {
  if (!ws || ws.readyState !== WebSocket.OPEN || initSent) return;
  ws.send(JSON.stringify({ type: 'init', share: shareName }));
  initSent = true;
}

function connectWebSocket() {
  initSent = false;
  ws = new WebSocket(serverUrl);
  ws.on('open', () => {
    logger.info('connected to sync server', { server: serverUrl });
    requestInit();
  });
  ws.on('message', (data) => {
    handleMessage(data).catch((err) => logger.error('message handler failed', err.message));
  });
  ws.on('close', () => {
    logger.warn('server connection closed, will reconnect shortly');
    scheduleReconnect();
  });
  ws.on('error', (err) => {
    logger.error('connection error', err.message);
    scheduleReconnect();
  });
}

async function applySnapshot(snapshot) {
  await fs.ensureDir(localDir);
  await fs.emptyDir(localDir);
  for (const dir of snapshot.directories || []) {
    await fs.ensureDir(path.join(localDir, dir));
  }
  for (const file of snapshot.files || []) {
    const target = path.join(localDir, file.path);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, Buffer.from(file.content, file.encoding || 'base64'));
    suppressEvent(file.path);
  }
  logger.info('snapshot applied', { files: (snapshot.files || []).length, dirs: (snapshot.directories || []).length });
  startLocalWatcher();
}

async function applyRemoteChange(change) {
  const targetPath = path.join(localDir, change.path);
  if (change.action === 'ensureDir') {
    await fs.ensureDir(targetPath);
  } else if (change.action === 'update') {
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, Buffer.from(change.content || '', change.encoding || 'base64'));
  } else if (change.action === 'delete') {
    await fs.remove(targetPath);
  }
  suppressEvent(change.path);
  logger.info('remote change applied', { action: change.action, path: change.path });
}

async function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (err) {
    logger.warn('invalid server message', err.message);
    return;
  }
  if (msg.type === 'share-list') {
    const available = (msg.shares || []).map((s) => s.name).join(', ');
    logger.info('server shares', { available });
    requestInit();
    return;
  }
  if (msg.type === 'snapshot') {
    logger.info('received snapshot', { share: msg.share });
    await applySnapshot(msg.snapshot || {});
    return;
  }
  if (msg.type === 'file-change') {
    await applyRemoteChange(msg);
    return;
  }
  if (msg.type === 'error') {
    logger.warn('server error', msg.message);
  }
}

async function startClient() {
  await chooseLocalDir();
  logger.info('client configured', { server: serverUrl, share: shareName, localDir });
  connectWebSocket();
}

startClient().catch((err) => {
  logger.error('failed to start client', err.message);
  process.exit(1);
});

process.on('uncaughtException', (err) => logger.error('uncaught exception', err.stack || err.message));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));
