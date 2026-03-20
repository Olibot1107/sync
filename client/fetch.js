const fs = require('fs-extra');
const path = require('path');
const yargs = require('yargs/yargs');

const settings = require('./settings');
const createMetadataStore = require('./metadata');

const argv = yargs(process.argv.slice(2))
  .option('share', {
    type: 'string',
    describe: 'Share name to fetch from',
    default: settings.share
  })
  .option('local', {
    type: 'string',
    describe: 'Local mirror folder',
    default: settings.local
  })
  .option('path', {
    type: 'string',
    describe: 'Relative file to fetch',
    demandOption: true
  })
  .help(false)
  .parse();

const localDir = path.resolve(process.cwd(), argv.local);
const metadataStore = createMetadataStore(localDir);

function normalizeRelPath(rel) {
  if (!rel) return '';
  return rel.split(path.sep).join('/');
}

async function main() {
  await metadataStore.init();
  await fs.ensureDir(metadataStore.prefetchDir);

  const request = {
    share: argv.share,
    path: normalizeRelPath(argv.path),
    timestamp: Date.now()
  };
  const filename = `prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const filePath = path.join(metadataStore.prefetchDir, filename);
  await fs.writeFile(filePath, JSON.stringify(request));
  console.log('fetch request queued', request);
}

main().catch((err) => {
  console.error('failed to queue fetch request', err);
  process.exit(1);
});
