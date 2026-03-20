const util = require('util');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const ANSI = {
  reset: '\x1b[0m',
  grey: '\x1b[90m',
  debug: '\x1b[94m',
  info: '\x1b[92m',
  warn: '\x1b[93m',
  error: '\x1b[91m',
  cyan: '\x1b[36m'
};

function normalizeLevel(level) {
  const normalized = String(level || '').toLowerCase();
  return LEVELS[normalized] != null ? normalized : 'info';
}

function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (typeof meta === 'string') return meta;
  return util.inspect(meta, { depth: 3, colors: false, compact: true });
}

function colorText(color, text) {
  return `${color}${text}${ANSI.reset}`;
}

function createLogger(name, options = {}) {
  const label = name || 'app';
  const levelName = normalizeLevel(options.level);
  const currentLevel = LEVELS[levelName];

  function log(level, message, meta) {
    if (LEVELS[level] < currentLevel) return;
    const timestamp = colorText(ANSI.grey, new Date().toISOString());
    const levelColor = ANSI[level] || ANSI.info;
    const levelTag = colorText(levelColor, level.toUpperCase().padEnd(5));
    const labelTag = colorText(ANSI.cyan, label);
    const metaText = formatMeta(meta);
    const payload = metaText ? `${message} ${metaText}` : message;
    console.log(`${timestamp} ${levelTag} [${labelTag}] ${payload}`);
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta)
  };
}

module.exports = createLogger;
