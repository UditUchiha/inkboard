/**
 * Runs tasks one after another for each key (tasks with different keys don't wait for
 * each other), so a check followed by a write can't be overtaken by a second request
 * for the same thing. It only orders work within this process, which is all the app
 * has: boards that are open live in this process's memory too.
 *
 *   const saving = keyedQueue();
 *   await saving(userId, async () => { ...check, then write... });
 */
export function keyedQueue() {
  const tails = new Map();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  };
}
