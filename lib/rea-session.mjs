import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { reaEnvironment } from './config.mjs';
import { terminateOwnedChild } from './jobs.mjs';

// The transport owns the ChildProcess handle, so fallback cleanup never uses a saved PID.
export class OwnedStdioTransport {
  constructor(config) { this.config = config; this.buffer = new ReadBuffer(); this.stderr = ''; }
  async start() {
    if (this.child) throw new Error('Transport already started');
    const child = this.child = spawn(process.execPath, [this.config.rea.entry, '--mcp'], {
      env: reaEnvironment(this.config), windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.finished = new Promise(resolve => child.once('close', () => { this.onclose?.(); resolve(); }));
    child.on('error', error => this.onerror?.(error));
    child.stdin.on('error', error => this.onerror?.(error));
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8000); });
    child.stdout.on('data', chunk => {
      this.buffer.append(chunk);
      try { let message; while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message); }
      catch (error) { this.onerror?.(error); }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  async send(message) {
    if (!this.child || this.child.exitCode !== null) throw new Error('REA connection is closed');
    await new Promise((resolve, reject) => this.child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.child) return;
      this.child.stdin.end();
      let timer;
      await Promise.race([this.finished, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null) await terminateOwnedChild(this.child);
      await this.finished;
      this.buffer.clear();
    })();
    return this.closing;
  }
}

export function unwrapRea(result) {
  const data = result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
  return data;
}

export class ReaSession {
  constructor(config) { this.transport = new OwnedStdioTransport(config); this.client = new Client({ name: 'software-analysis-workbench', version: '0.2.0' }); }
  async open(signal) { await this.client.connect(this.transport, { signal, timeout: 20000 }); return this; }
  async call(name, args, signal, timeout = 90000) {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout });
    const data = unwrapRea(result);
    if (result.isError || data.error) {
      const error = new Error(data.error?.message || `REA ${name} failed`);
      error.provider = data.error || data; throw error;
    }
    return data;
  }
  async close() { await this.client.close(); await this.transport.close(); }
}
