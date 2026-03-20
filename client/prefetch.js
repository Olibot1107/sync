const fs = require('fs-extra');
const path = require('path');
const yargs = require('yargs/yargs');

const settings = require('./settings');
const createMetadataStore = require('./metadata');

const argv = yargs(process.argv.slice(2))
  .option('server', {
    type: 'string',
    describe: 'WebSocket server URL',
    default: settings.server
  })
  .option('share', {
    type: 'string',
    describe: 'Share name to prefetch from',
    default: settings.share
  })
  .option('local', {
    type: 'string',
    describe: 'Local mirror directory',
    default: settings.local
  })
  .option('path', {
    type: 'string',
    describe: 'Relative path (folder) to prefetch',
    demandOption: true
  })
  .help(false)
  .parse();

const localDir = path.resolve(process.cwd(), argv.local);
const shareName = argv.share;
const prefetchDir = path.join(localDir, '.sync', 'prefetch');

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

async function main() {
  const metadataStore = createMetadataStore(localDir);
  await metadataStore.init();
  await fs.ensureDir(metadataStore.prefetchDir);

  const normalizedPath = normalizeRelPath(argv.path || '');
  const request = {
    share: shareName,
    path: normalizedPath,
    timestamp: Date.now()
  };
  const filename = `prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const target = path.join(metadataStore.prefetchDir, filename);
  await fs.writeFile(target, JSON.stringify(request));
  console.log('prefetch request queued', request);
}

main().catch((err) => {
  console.error('failed to queue prefetch', err);
  process.exit(1);
});
