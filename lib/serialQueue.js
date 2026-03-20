function createSerialQueue({ onError } = {}) {
  const tasks = [];
  let running = false;

  async function runNext() {
    if (running || tasks.length === 0) return;
    running = true;
    const job = tasks.shift();
    try {
      await job();
    } catch (err) {
      if (onError) {
        try {
          onError(err);
        } catch (cbErr) {
          console.error('serial queue onError failed', cbErr);
        }
      }
    }
    running = false;
    runNext();
  }

  return {
    push(job) {
      tasks.push(job);
      runNext();
    }
  };
}

module.exports = createSerialQueue;
