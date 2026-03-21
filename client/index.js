const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const readline = require('readline');
const yargs = require('yargs/yargs');
const zlib = require('zlib');

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
const clientPassword = process.env.SYNC_PASSWORD || settings.password || '';
const SNAPSHOT_PROGRESS_THRESHOLD = Number(process.env.SYNC_SNAPSHOT_PROGRESS_THRESHOLD || 200);

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
let snapshotContext = null;

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

const localIgnoredPatterns = (settings.ignoredPaths || [])
  .map((pattern) => normalizeRelPath(pattern))
  .filter(Boolean);

function matchesIgnorePattern(rel, pattern) {
  if (!rel || !pattern) return false;
  if (rel === pattern) return true;
  return rel.startsWith(`${pattern}/`);
}

function isLocalIgnoredPath(rel) {
  return localIgnoredPatterns.some((pattern) => matchesIgnorePattern(rel, pattern));
}

function isConflictPath(rel) {
  return rel === '.conflicts' || rel.startsWith('.conflicts/');
}

function shouldSkipLocalRel(rel) {
  return isConflictPath(rel) || isLocalIgnoredPath(rel);
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
  const options = {
    persistent: true,
    ignoreInitial: true,
    ignored: (p) => {
      const rel = normalizeRelPath(path.relative(localDir, p));
      return rel && shouldSkipLocalRel(rel);
    }
  };
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

function stopLocalWatcher() {
  if (localWatcher) {
    localWatcher.close();
    localWatcher = null;
  }
}

async function handleLocalChange(action, absolutePath, includeContent) {
  const relPath = normalizeRelPath(path.relative(localDir, absolutePath));
  if (!relPath) return;
  if (isSuppressed(relPath)) {
    logger.debug('ignored suppressed local event', { path: relPath, action });
    return;
  }
  if (shouldSkipLocalRel(relPath)) {
    logger.debug('ignored local change for skipped path', { path: relPath, action });
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
  ws.send(JSON.stringify({ type: 'init', share: shareName, password: clientPassword }));
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

async function handleSnapshotMetadata(snapshot) {
  stopLocalWatcher();
  snapshotContext = null;
  await fs.ensureDir(localDir);
  const directories = (snapshot.directories || []).filter(Boolean);
  const filesMeta = snapshot.files || [];
  await clearLocalMirror();
  for (const dir of directories) {
    await fs.ensureDir(path.join(localDir, dir));
  }
  snapshotContext = {
    totalFiles: filesMeta.length,
    processedFiles: 0,
    dirCount: directories.length,
    lastPercent: -1,
    lastFolder: '',
    completeReceived: false
  };
  sendSnapshotReady();
}

function sendSnapshotReady() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'snapshot-ready', share: shareName }));
}

async function handleSnapshotFileMessage(msg) {
  const context = snapshotContext;
  if (!context) {
    logger.warn('snapshot file received without an active snapshot', { path: msg?.file?.path });
    return;
  }
  const file = msg.file;
  if (!file || !file.path) {
    logger.warn('snapshot file message missing payload', { share: msg.share });
    return;
  }
  const target = path.join(localDir, file.path);
  try {
    await fs.ensureDir(path.dirname(target));
    let buffer = Buffer.from(file.content || '', file.encoding || 'base64');
    if (file.compressed) {
      try {
        buffer = zlib.inflateSync(buffer);
      } catch (err) {
        logger.warn('failed to decompress snapshot file', { path: file.path, err: err.message });
        buffer = Buffer.from(file.content || '', file.encoding || 'base64');
      }
    }
    await fs.writeFile(target, buffer);
  } catch (err) {
    logger.warn('failed to write snapshot file', err.message);
    return;
  }
  suppressEvent(file.path);
  context.processedFiles += 1;
  if (context.totalFiles > 0 && context.totalFiles >= SNAPSHOT_PROGRESS_THRESHOLD) {
    const percent = Math.floor((context.processedFiles / context.totalFiles) * 100);
    const folder = file.path.split('/')[0] || '.';
    if (percent !== context.lastPercent || folder !== context.lastFolder) {
      logger.info('snapshot progress', {
        share: shareName,
        folder,
        percent,
        path: file.path
      });
      context.lastPercent = percent;
      context.lastFolder = folder;
    }
  }
  await maybeFinalizeSnapshot();
}

function handleSnapshotComplete(msg) {
  const context = snapshotContext;
  if (!context) {
    logger.warn('snapshot complete received without an active snapshot', { share: msg.share });
    return;
  }
  if (typeof msg.files === 'number') {
    context.totalFiles = msg.files;
  }
  context.completeReceived = true;
  maybeFinalizeSnapshot();
}

async function maybeFinalizeSnapshot() {
  const context = snapshotContext;
  if (!context) return;
  if (!context.completeReceived) return;
  if (context.processedFiles !== context.totalFiles) return;
  logger.info('snapshot applied', { files: context.processedFiles, dirs: context.dirCount });
  snapshotContext = null;
  startLocalWatcher();
}

async function clearLocalMirror() {
  const entries = await fs.readdir(localDir);
  for (const entry of entries) {
    const relEntry = normalizeRelPath(entry);
    if (!relEntry) continue;
    if (shouldSkipLocalRel(relEntry)) continue;
    await fs.remove(path.join(localDir, entry));
  }
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
    logger.info('received snapshot metadata', { share: msg.share });
    await handleSnapshotMetadata(msg.snapshot || {});
    return;
  }
  if (msg.type === 'snapshot-file') {
    await handleSnapshotFileMessage(msg);
    return;
  }
  if (msg.type === 'snapshot-complete') {
    handleSnapshotComplete(msg);
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
