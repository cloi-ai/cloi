/**
 * CLI Tools Module
 * 
 * Provides essential command-line interface utilities for:
 * 1. Command execution and network connectivity
 * 2. File system operations (directory creation, debug logging)
 * 
 * This module serves as the foundation for system interactions including
 * terminal commands, network checks, and file operations throughout the application.
 */

import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';

/* ───────────────────────── Synchronous Command Execution ────────────────────────────── */
/**
 * Synchronously executes a shell command, capturing stdout and stderr.
 * Includes a timeout to prevent hanging processes.
 * @param {string} cmd - The command to execute.
 * @param {number} [timeout=10000] - Timeout in milliseconds.
 * @returns {{ok: boolean, output: string}} - An object indicating success and the combined output.
 */
export function runCommand(cmd, timeout = 10000) {
  try {
    // Use the user's actual shell for better compatibility
    const shell = process.env.SHELL || '/bin/bash';
    
    // For pip install and similar commands, we want them to run in the user's environment
    // Use inherit stdio for interactive commands like pip that might need user input
    const options = {
      encoding: 'utf8',
      timeout,
      shell: shell,
      stdio: 'pipe' // Use pipe to capture output but allow interaction if needed
    };
    
    console.log(`Executing: ${cmd}`);
    const out = execSync(`${cmd} 2>&1`, options);
    return { ok: true, output: out };
  } catch (e) {
    // Better error handling for different types of failures
    const errorOutput = e.stdout?.toString() || e.stderr?.toString() || e.message;
    console.log(`Command failed with error: ${errorOutput}`);
    return { ok: false, output: errorOutput };
  }
}

/**
 * Runs a command interactively in the user's terminal environment.
 * This is specifically for commands that need to persist (like pip install, npm install)
 * and may require user interaction.
 * @param {string} cmd - The command to execute.
 * @returns {Promise<{ok: boolean, output: string}>} - Promise resolving to execution result.
 */
export function runInteractiveCommand(cmd) {
  return new Promise((resolve) => {
    console.log(`Running interactively: ${cmd}`);
    
    // Split command into parts for spawn
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);
    
    // Use spawn with inherit stdio so it runs in the user's actual terminal
    const child = spawn(command, args, {
      stdio: 'inherit', // This allows the command to run in the actual terminal
      shell: true,
      env: process.env // Use the full environment
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, output: `Command completed successfully` });
      } else {
        resolve({ ok: false, output: `Command exited with code ${code}` });
      }
    });
    
    child.on('error', (error) => {
      resolve({ ok: false, output: `Failed to start command: ${error.message}` });
    });
  });
}

/* ───────────────────────── Network Connectivity Check ────────────────────────────── */
/**
 * Checks for basic network connectivity by pinging a reliable host.
 * @returns {boolean} - True if the network seems reachable.
 */
export function checkNetwork() {
  try {
    // Try to connect to a reliable host
    execSync('ping -c 1 -t 1 8.8.8.8', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/* ──────────────── Check Directory Existence ─────────────────────── */
/**
 * Ensures that a directory exists, creating it if necessary.
 * @param {string} dir - The directory path to ensure.
 * @returns {Promise<void>}
 */
export async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    // Ignore error if directory already exists
    if (err.code !== 'EEXIST') throw err;
  }
}

/* ───────────────────────── Write Debug Log ────────────────────────────── */
/**
 * Writes a debug log file with the history of iterations in a debug session.
 * @param {Array} historyArr - Array of objects with error, patch, and analysis data.
 * @param {string} logPath - The path to write the log file.
 * @returns {Promise<void>}
 */
export async function writeDebugLog(historyArr, logPath) {
  // Ensure the parent directory exists
  await ensureDir(dirname(logPath));
  
  // Check if this is a JSON log (agentic session) or text log (legacy)
  if (logPath.endsWith('.json')) {
    // Write as JSON for agentic sessions
    await fs.writeFile(logPath, JSON.stringify(historyArr, null, 2), 'utf8');
  } else {
    // Write as text for legacy sessions
    const content = historyArr.map((iteration, i) => {
      return `=== ITERATION ${i + 1} ===\n\n` +
             `ERROR:\n${iteration.error}\n\n` +
             `ANALYSIS:\n${iteration.analysis}\n\n` +
             `PATCH:\n${iteration.patch}\n\n` +
             '='.repeat(50) + '\n\n';
    }).join('');
    
    await fs.writeFile(logPath, content, 'utf8');
  }
} 