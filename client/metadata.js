const fs = require('fs-extra');
const path = require('path');

function createMetadataStore(localDir) {
  const metadataDir = path.join(localDir, '.sync');
  const prefetchDir = path.join(metadataDir, 'prefetch');
  const metadataPath = path.join(metadataDir, 'metadata.json');
  const entries = new Map();
  let initPromise = null;
  let persistPromise = Promise.resolve();

  async function init() {
    await fs.ensureDir(metadataDir);
    await fs.ensureDir(prefetchDir);
    try {
      const raw = await fs.readFile(metadataPath, 'utf-8');
      const parsed = JSON.parse(raw);
      parsed.forEach((item) => entries.set(item.path, item));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  function schedulePersist() {
    const payload = Array.from(entries.values());
    persistPromise = persistPromise.then(() => fs.writeFile(metadataPath, JSON.stringify(payload, null, 2))).catch((err) => {
      console.error('metadata persist failed', err);
    });
    return persistPromise;
  }

  async function overwrite(items) {
    entries.clear();
    items.forEach((item) => entries.set(item.path, item));
    await schedulePersist();
  }

  async function upsert(item) {
    entries.set(item.path, item);
    await schedulePersist();
  }

  async function remove(relPath) {
    if (entries.delete(relPath)) {
      await schedulePersist();
    }
  }

  async function clear() {
    entries.clear();
    await schedulePersist();
  }

  async function markFetched(relPath, metadata = {}) {
    const existing = entries.get(relPath) || { path: relPath };
    entries.set(relPath, {
      ...existing,
      ...metadata,
      downloaded: true,
      lastFetched: Date.now()
    });
    await schedulePersist();
  }

  function get(relPath) {
    return entries.get(relPath);
  }

  function list() {
    return Array.from(entries.values());
  }

  return {
    metadataDir,
    metadataPath,
    prefetchDir,
    init: () => {
      if (!initPromise) {
        initPromise = init();
      }
      return initPromise;
    },
    overwrite,
    upsert,
    remove,
    clear,
    markFetched,
    get,
    list
  };
}

module.exports = createMetadataStore;
