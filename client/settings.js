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

const fileConfig = readConfig();

const resolved = {
  server: fileConfig.server || 'ws://localhost:3001',
  share: fileConfig.share || 'projects',
  local: fileConfig.local || './client-sync',
  logLevel: (fileConfig.logLevel || 'info').toLowerCase()
};

module.exports = resolved;
