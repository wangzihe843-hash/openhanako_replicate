/**
 * 并发限流器：限制同时在飞的子 agent 数（信号量），并对累计派发总数设 backstop。
 * @param {{ maxConcurrent: number, maxTotal: number }} opts
 */
export function createLimiter({ maxConcurrent, maxTotal }) {
  let active = 0;
  let total = 0;
  /** @type {Array<{ thunk: () => Promise<any>, resolve: Function, reject: Function }>} */
  const queue = [];

  function pump() {
    if (active >= maxConcurrent) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    Promise.resolve()
      .then(job.thunk)
      .then(job.resolve, job.reject)
      .finally(() => { active--; pump(); });
  }

  return {
    /**
     * @template T
     * @param {() => Promise<T>} thunk
     * @returns {Promise<T>}
     */
    run(thunk) {
      // 先判 cap 再自增：被拒（从未运行）的 agent 不应计入 totalSpawned。
      // 准入阈值不变——仍恰好放行 maxTotal 个，拒第 maxTotal+1 个。
      if (total + 1 > maxTotal) {
        return Promise.reject(new Error(`workflow 超出 agent 总数上限 ${maxTotal}（防失控 backstop）`));
      }
      total++;
      return new Promise((resolve, reject) => {
        queue.push({ thunk, resolve, reject });
        pump();
      });
    },
    get activeCount() { return active; },
    get totalSpawned() { return total; },
  };
}
