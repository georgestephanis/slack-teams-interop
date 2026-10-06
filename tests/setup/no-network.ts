/**
 * Blocks outbound network connections during tests. Specs talk to Slack and Teams only through
 * mocks; a real connection means a test (or the code under test) is reaching a live API, which
 * makes the suite slow and flaky and can act on real workspaces. Loopback is allowed for the
 * servers tests start themselves.
 */

import net from 'node:net';
import { afterEach } from 'vitest';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
const blocked: string[] = [];

/** Host from any of net.Socket#connect's call forms (options object, or port + host). */
function targetHost(args: unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    const opts = first as { host?: string; path?: string };
    if (opts.path) return undefined; // Unix socket / named pipe
    return opts.host ?? 'localhost';
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return undefined; // IPC path
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    blocked.push(host);
    // Fail like an unreachable host, so callers see an ordinary network error
    process.nextTick(() => this.destroy(new Error(`Network access to ${host} is blocked in tests`)));
    return this;
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

afterEach(() => {
  if (blocked.length === 0) return;
  const hosts = [...new Set(blocked.splice(0))].join(', ');
  throw new Error(`Test attempted network access to: ${hosts}. Mock the client instead.`);
});
