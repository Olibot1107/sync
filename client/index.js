const WebSocket = require('ws');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const path = require('path');
const yargs = require('yargs/yargs');

const settings = require('./settings');
const createLogger = require('../lib/logger');
const createSerialQueue = require('../lib/serialQueue');
const createMetadataStore = require('./metadata');

const argv = yargs(process.argv.slice(2))
  .option('server', {
    type: 'string',
    describe: 'WebSocket server URL',
    default: settings.server
  })
  .option('share', {
    type: 'string',
    describe: 'Share name that the client wants to sync',
    default: settings.share
  })
  .option('local', {
    type: 'string',
    describe: 'Local folder where shared files will be mirrored',
    default: settings.local
  })
  .option('log-level', {
    type: 'string',
    choices: ['debug', 'info', 'warn', 'error'],
    describe: 'Logging verbosity',
    default: settings.logLevel
  })
  .help(false)
  .parse();

const serverUrl = argv.server;
const shareName = argv.share;
const localDir = path.resolve(process.cwd(), argv.local);
const metadataStore = createMetadataStore(localDir);
const metadataReady = metadataStore.init();
const logger = createLogger('sync-client', { level: argv['log-level'] });
const localQueue = createSerialQueue({
  onError: (err) => logger.error('local queue error', err.message || err)
});
const remoteQueue = createSerialQueue({
  onError: (err) => logger.error('remote queue error', err.message || err)
});
const prefetchQueue = createSerialQueue({
  onError: (err) => logger.error('prefetch queue error', err.message || err)
});
const pendingContentFetches = new Map();
let shareReadyResolve;
let shareReady = false;
const shareReadyPromise = new Promise((resolve) => {
  shareReadyResolve = resolve;
});
let prefetchWatcherStarted = false;

let localWatcher;
const localSuppressed = new Map();

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

function suppressLocalEvent(relPath) {
  const key = relPath || '.';
  const expires = Date.now() + 500;
  localSuppressed.set(key, expires);
  setTimeout(() => {
    if (localSuppressed.get(key) === expires) {
      localSuppressed.delete(key);
    }
  }, 600);
}

function isLocalSuppressed(relPath) {
  const key = relPath || '.';
  return localSuppressed.has(key);
}

function startLocalWatcher() {
  if (localWatcher) {
    localWatcher.close();
    localWatcher = null;
  }

  const options = {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50
    },
    ignored: (p) => p.startsWith(metadataStore.metadataDir)
  };

  localWatcher = chokidar.watch(localDir, options);
  const forward = (action, absolute, includeContent) => {
    localQueue.push(() => handleLocalChange(action, absolute, includeContent));
  };

  localWatcher.on('add', (p) => forward('update', p, true));
  localWatcher.on('change', (p) => forward('update', p, true));
  localWatcher.on('unlink', (p) => forward('delete', p, false));
  localWatcher.on('addDir', (p) => forward('ensureDir', p, false));
  localWatcher.on('unlinkDir', (p) => forward('delete', p, false));
  localWatcher.on('ready', () => logger.info('local watcher ready', { path: localDir }));
  localWatcher.on('error', (err) => logger.error('local watcher error', err.message));
}

async function handleLocalChange(action, absolutePath, includeContent) {
  await metadataReady;
  const relPath = normalizeRelPath(path.relative(localDir, absolutePath));
  if (!relPath) return;
  if (isLocalSuppressed(relPath)) {
    logger.debug('suppressed local event', { action, path: relPath });
    return;
  }
  logger.info('local filesystem change detected', { action, path: relPath });
  if (action === 'update' && includeContent) {
    const data = await fs.readFile(absolutePath);
    sendFileChange({ action, path: relPath, encoding: 'base64', content: data.toString('base64') });
    const stats = await fs.stat(absolutePath);
    await metadataStore.upsert({
      path: relPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      downloaded: true,
      lastFetched: Date.now()
    });
  } else {
    sendFileChange({ action, path: relPath });
    if (action === 'delete') {
      await metadataStore.remove(relPath);
    }
  }
}

function ensureDirSuppressed(relPath) {
  if (!relPath || relPath === '.') return;
  suppressLocalEvent(relPath);
  const parent = path.dirname(relPath);
  if (parent && parent !== relPath) {
    suppressLocalEvent(parent);
  }
}

async function fetchFileContent(relPath) {
  await shareReadyPromise;
  const pending = pendingContentFetches.get(relPath);
  if (pending) {
    return pending.promise;
  }

  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  pendingContentFetches.set(relPath, {
    resolve: resolveFn,
    reject: rejectFn,
    promise
  });

  try {
    ws.send(JSON.stringify({ type: 'request-file', share: shareName, path: relPath }));
  } catch (err) {
    pendingContentFetches.delete(relPath);
    rejectFn(err);
  }

  return promise;
}

async function prefetchDirectory(dirPath) {
  const normalizedDir = normalizeRelPath(dirPath || '');
  await metadataReady;
  const allEntries = metadataStore.list();
  const prefix = normalizedDir ? `${normalizedDir}/` : '';
  const candidates = allEntries.filter((entry) => {
    if (!normalizedDir) return true;
    return entry.path === normalizedDir || entry.path.startsWith(prefix);
  });

  for (const entry of candidates) {
    if (entry.downloaded) continue;
    await fetchFileContent(entry.path);
  }
}

async function handlePrefetchCommand(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    await fs.remove(filePath);
    const payload = JSON.parse(raw);
    await prefetchDirectory(payload.path || '');
  } catch (err) {
    logger.error('failed to handle prefetch request', err.message);
  }
}

async function setupPrefetchWatcher() {
  if (prefetchWatcherStarted) return;
  prefetchWatcherStarted = true;
  await metadataReady;
  await fs.ensureDir(metadataStore.prefetchDir);
  const watcher = chokidar.watch(metadataStore.prefetchDir, { ignoreInitial: true, depth: 0 });
  watcher.on('add', (filePath) => {
    prefetchQueue.push(() => handlePrefetchCommand(filePath));
  });
}

function sendFileChange(change) {
  if (ws.readyState !== WebSocket.OPEN) {
    logger.warn('ws not open yet, skipping local change', { change });
    return;
  }
  logger.debug('sending file change', change);
  ws.send(JSON.stringify({
    type: 'file-change',
    share: shareName,
    ...change
  }));
}

async function applySnapshot(snapshot) {
  await metadataReady;
  await fs.ensureDir(localDir);

  for (const dir of snapshot.directories || []) {
    const absolute = path.join(localDir, dir);
    await fs.ensureDir(absolute);
  }

  const entries = (snapshot.files || []).map((file) => ({
    path: file.path,
    size: file.size || 0,
    mtimeMs: file.mtimeMs || Date.now(),
    downloaded: false,
    lastFetched: null
  }));
  await metadataStore.overwrite(entries);

  logger.info('snapshot applied', {
    directories: (snapshot.directories || []).length,
    files: entries.length,
    localDir
  });
  startLocalWatcher();
  await setupPrefetchWatcher();
  if (!shareReady && shareReadyResolve) {
    shareReady = true;
    shareReadyResolve();
  }
}

async function removeLocalFile(relPath) {
  const targetPath = path.join(localDir, relPath);
  suppressLocalEvent(relPath);
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }
}

async function applyRemoteChange(change) {
  await metadataReady;
  const metadata = {
    path: change.path,
    size: change.metadata?.size || 0,
    mtimeMs: change.metadata?.mtimeMs || Date.now(),
    downloaded: false,
    lastFetched: null
  };

  if (change.action === 'ensureDir') {
    await fs.ensureDir(path.join(localDir, change.path));
    await metadataStore.upsert(metadata);
  } else if (change.action === 'update') {
    await metadataStore.upsert(metadata);
    await removeLocalFile(change.path);
  } else if (change.action === 'delete') {
    await metadataStore.remove(change.path);
    await removeLocalFile(change.path);
  }

  logger.debug('applied remote change', change);
  logger.info('remote change applied locally', {
    action: change.action,
    path: change.path
  });
}

async function handleFileContent(msg) {
  if (msg.share !== shareName) return;
  await metadataReady;
  const targetPath = path.join(localDir, msg.path);
  ensureDirSuppressed(path.dirname(msg.path));
  await fs.ensureDir(path.dirname(targetPath));
  suppressLocalEvent(msg.path);
  await fs.writeFile(targetPath, Buffer.from(msg.content || '', msg.encoding || 'base64'));
  await metadataStore.markFetched(msg.path, {
    size: msg.metadata?.size || 0,
    mtimeMs: msg.metadata?.mtimeMs || Date.now()
  });
  const pending = pendingContentFetches.get(msg.path);
  if (pending) {
    pending.resolve();
    pendingContentFetches.delete(msg.path);
  }
  logger.info('file content fetched', { path: msg.path });
}

const ws = new WebSocket(serverUrl);
let initSent = false;

logger.info('client configured', { server: serverUrl, share: shareName, localDir, logLevel: argv['log-level'] });

ws.on('open', () => {
  logger.info('connected to sync server', { server: serverUrl });
});

ws.on('message', (data) => {
  handleMessage(data).catch((err) => {
    logger.error('message handler failed', err.message);
  });
});

async function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (err) {
    logger.warn('invalid server message', err.message);
    return;
  }

  if (msg.type === 'share-list') {
    const available = (msg.shares || []).map((share) => share.name).join(', ');
    logger.info('server shares', { available });
    if (!initSent) {
      ws.send(JSON.stringify({ type: 'init', share: shareName }));
      initSent = true;
    }
    return;
  }

  if (msg.type === 'snapshot') {
    logger.info('received snapshot', { share: msg.share });
    await applySnapshot(msg.snapshot || {});
    return;
  }

  if (msg.type === 'file-content') {
    await handleFileContent(msg);
    return;
  }

  if (msg.type === 'file-change') {
    remoteQueue.push(() => applyRemoteChange(msg));
    return;
  }

  if (msg.type === 'error') {
    logger.warn('server error', msg.message);
  }
}

ws.on('close', () => {
  logger.info('server connection closed');
});

ws.on('error', (err) => {
  logger.error('connection error', err.message);
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', reason);
});
