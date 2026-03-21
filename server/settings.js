const fs = require('fs-extra');
const os = require('os');
const path = require('path');

function ensureConfigFile() {
  const configPath = path.resolve(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    return;
  }
  const baseDir = path.resolve(__dirname, 'shared');
  fs.ensureDirSync(baseDir);
  const template = {
    port: 3130,
    logLevel: 'info',
    shares: [
      {
        name: 'projects',
        path: './shared/projects'
      }
    ],
    snapshotCompression: true,
    password: 'changeme'
  };
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
}

function readConfig() {
  const configPath = path.resolve(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Unable to parse ${configPath}: ${err.message}`);
  }
}

function parseEnvShares() {
  const env = process.env.SYNC_SHARES;
  if (!env) return null;
  try {
    const parsed = JSON.parse(env);
    if (!Array.isArray(parsed)) {
      throw new Error('SYNC_SHARES must be a JSON array');
    }
    return parsed;
  } catch (err) {
    throw new Error(`SYNC_SHARES is invalid JSON: ${err.message}`);
  }
}

function expandHome(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return rawPath;
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function tidyIgnorePaths(rawPaths) {
  if (!Array.isArray(rawPaths)) {
    return [];
  }
  return rawPaths
    .map((value) => {
      if (typeof value !== 'string') return '';
      const trimmed = value.trim();
      if (!trimmed) return '';
      return trimmed.split(path.sep).join('/').replace(/^\/+/, '');
    })
    .filter(Boolean);
}

function normalizeShare(share) {
  if (!share || !share.name || !share.path) {
    throw new Error('Share definitions require a name and path');
  }
  const rawPath = expandHome(share.path);
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);
  const userIgnored = share.hasOwnProperty('ignoredPaths') ? share.ignoredPaths : share.ignore;
  const normalizedIgnored = tidyIgnorePaths(userIgnored);
  const ignoredPaths = userIgnored ? normalizedIgnored : normalizedIgnored.length ? normalizedIgnored : ['.git', '.DS_Store'];
  return {
    name: share.name,
    path: resolved,
    ignoredPaths
  };
}

function loadSettings() {
  ensureConfigFile();
  const config = readConfig();
  const envShares = parseEnvShares();
  const shares = (envShares || config.shares || []).map(normalizeShare);
  if (!shares.length) {
    throw new Error('No shares defined (set SERVER_SHARES or add entries to server/config.json)');
  }

  const port = Number(process.env.PORT || process.env.SYNC_PORT || config.port) || 3001;
  const logLevel = (process.env.LOG_LEVEL || config.logLevel || 'info').toLowerCase();
  const password = process.env.SYNC_PASSWORD || config.password || 'changeme';
  const snapshotCompression = config.hasOwnProperty('snapshotCompression') ? Boolean(config.snapshotCompression) : true;

  return { port, logLevel, shares, password, snapshotCompression };
}

module.exports = loadSettings();
