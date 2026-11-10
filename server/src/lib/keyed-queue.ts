// Runs tasks one after another per key (different keys don't wait), so a check followed by a write can't be overtaken
// by a second request for the same thing. Orders work only within this process, which is all the app has.
export function keyedQueue() {
  const tails = new Map<unknown, Promise<unknown>>();
  return <Result>(key: unknown, task: () => Result | PromiseLike<Result>): Promise<Result> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  };
}
