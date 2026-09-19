import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Stop, json } from './lib.mjs';

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    // Only ESRCH proves that the process has gone. Permission errors or
    // other ambiguous results must never cause us to remove a live lock.
    return err.code !== 'ESRCH';
  }
}

export async function acquireRunLock(file) {
  await mkdir(path.dirname(file), { recursive: true });
  const port = 20000 + createHash('sha256').update(path.basename(file).toLowerCase()).digest().readUInt32BE(0) % 40000;
  // This OS-owned guard vanishes even when the terminal is force-closed. It
  // serializes stale-file recovery so simultaneous restarts cannot both win.
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch {
    throw new Stop('已有运行实例，或本机互斥端口被占用；未启动第二个 mint。');
  }
  const close = () => new Promise(resolve => server.close(resolve));
  const token = randomUUID();
  let recovered = false;
  try {
    let old;
    try { old = JSON.parse(await readFile(file, 'utf8')); }
    catch (err) {
      if (err.code !== 'ENOENT') throw new Stop('运行锁文件损坏，需要核实进程后处理；交易记录未改动。');
    }
    if (old) {
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Stop('运行锁中的进程信息无效，未清理。');
      if (processExists(old.pid)) throw new Stop(`锁对应的进程 ${old.pid} 仍存在；不会清理或重复启动。`);
      await unlink(file);
      recovered = true;
    }
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(json({ version: 2, pid: process.pid, token, port, startedUtc: new Date().toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
    let released = false;
    return {
      recovered,
      async release() {
        if (released) return;
        released = true;
        try {
          let current;
          try { current = JSON.parse(await readFile(file, 'utf8')); }
          catch (err) { if (err.code !== 'ENOENT') throw err; }
          if (current?.token === token) await unlink(file);
        } finally { await close(); }
      }
    };
  } catch (err) {
    await close();
    throw err;
  }
}
