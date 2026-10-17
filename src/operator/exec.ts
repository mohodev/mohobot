/**
 * Real child_process-backed exec for operator tools.
 *
 * Shared by the chat plugin (plugins/operator) and the ACP server (src/acp)
 * so both surfaces run tools with identical containment: no shell, output
 * captured to memory, and a hard SIGKILL at the deadline.
 */

import type { ToolContext } from './registry.js';

/** Default exec: child_process with a hard kill after the deadline. */
export function createSpawnExec(): ToolContext['exec'] {
  return async (command, args, options) => {
    const { spawn } = await import('node:child_process');
    const timeoutMs = options?.timeoutMs ?? 30_000;
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: String(error.message) });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  };
}
