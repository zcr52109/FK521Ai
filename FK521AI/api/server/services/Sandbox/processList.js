const { execFile } = require('child_process');
const { promisify } = require('util');
const { readDifyConsoleConfig } = require('~/server/utils/difyConsoleConfig');
const { assertAdmin, createSandboxAccessError } = require('./requester');

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_PROCESSES = Number(process.env.FK521_PROCESS_LIST_MAX_PROCESSES || 200);

function parsePsOutput(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        state: match[3],
        elapsedTime: match[4],
        cpuPercent: Number(match[5]),
        rssKb: Number(match[6]),
        name: match[7],
      };
    })
    .filter(Boolean);
}

function collectDescendants(processes = [], rootPid) {
  const byParent = new Map();
  for (const processInfo of processes) {
    if (!byParent.has(processInfo.parentPid)) {
      byParent.set(processInfo.parentPid, []);
    }
    byParent.get(processInfo.parentPid).push(processInfo);
  }

  const queue = [rootPid];
  const descendants = new Map();
  while (queue.length > 0) {
    const currentPid = queue.shift();
    const children = byParent.get(currentPid) || [];
    for (const child of children) {
      if (!descendants.has(child.pid)) {
        descendants.set(child.pid, child);
        queue.push(child.pid);
      }
    }
  }

  return [...descendants.values()];
}

async function processList({ requester, scope = 'sandbox', maxProcesses = DEFAULT_MAX_PROCESSES } = {}) {
  const config = readDifyConsoleConfig();
  const sandboxTools = config.sandboxTools || {};
  if (sandboxTools.allowProcessList === false) {
    throw createSandboxAccessError('进程诊断能力未启用', 'PROCESS_LIST_DISABLED', 403);
  }

  assertAdmin(requester, 'process_list');

  const { stdout } = await execFileAsync(
    'ps',
    ['-eo', 'pid=,ppid=,state=,etime=,pcpu=,rss=,comm='],
    { maxBuffer: 5 * 1024 * 1024 },
  );

  const parsed = parsePsOutput(stdout);
  const selfProcess = parsed.find((entry) => entry.pid === process.pid) || {
    pid: process.pid,
    parentPid: process.ppid,
    state: 'R',
    elapsedTime: null,
    cpuPercent: 0,
    rssKb: Math.round(process.memoryUsage().rss / 1024),
    name: process.title || 'node',
  };

  let visible = parsed;
  if (scope !== 'all_visible') {
    visible = [selfProcess, ...collectDescendants(parsed, process.pid)].sort((a, b) => a.pid - b.pid);
  }

  const limited = visible.slice(0, Math.max(1, Number(maxProcesses) || DEFAULT_MAX_PROCESSES));
  return {
    scope,
    rootPid: process.pid,
    totalVisible: visible.length,
    truncated: visible.length > limited.length,
    processes: limited.map((item) => ({
      pid: item.pid,
      parentPid: item.parentPid,
      state: item.state,
      elapsedTime: item.elapsedTime,
      name: item.name,
    })),
  };
}

module.exports = {
  processList,
  parsePsOutput,
  collectDescendants,
};
