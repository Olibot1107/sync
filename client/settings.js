const fs = require('fs');
const path = require('path');

function readConfig() {
  const configPath = path.resolve(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.warn(`client config is invalid: ${err.message}`);
    return {};
  }
}

function ensureConfigFile() {
  const configPath = path.resolve(__dirname, 'config.json');
  if (fs.existsSync(configPath)) return;
  const defaultConfig = {
    server: 'ws://localhost:3130',
    share: 'projects',
    local: './client-sync',
    logLevel: 'info',
    sharePaths: {
      projects: './client-sync'
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
}

ensureConfigFile();
const fileConfig = readConfig();

const resolved = {
  server: fileConfig.server || 'ws://localhost:3130',
  share: fileConfig.share || 'projects',
  local: fileConfig.local || './client-sync',
  sharePaths: fileConfig.sharePaths || {},
  ignoredPaths: fileConfig.ignoredPaths || ['.git', '.DS_Store'],
  password: fileConfig.password || '',
  logLevel: (fileConfig.logLevel || 'info').toLowerCase(),
  reconnectDelayMs: Number(fileConfig.reconnectDelayMs || 5000)
};

module.exports = resolved;
