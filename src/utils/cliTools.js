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
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';

/* ───────────────────────── Synchronous Command Execution ────────────────────────────── */
/**
 * Synchronously executes a shell command, capturing stdout and stderr.
 * Includes a timeout to prevent hanging processes.
 * @param {string} cmd - The command to execute.
 * @param {number} [timeout=10000] - Timeout in milliseconds.
 * @returns {{ok: boolean, output: string}} - An object indicating success and the combined output.
 */
/**
 * Run a command with improved timeout handling
 * @param {string} cmd - Command to run
 * @param {number} timeout - Timeout in milliseconds (default: 5000)
 * @param {boolean} captureTimeoutAsError - If true, treat timeout as an error condition
 * @returns {Object} Result with ok status, output, and timedOut flag
 */
export function runCommand(cmd, timeout = 5000, captureTimeoutAsError = true) {
  try {
    // For commands that might run indefinitely, we use a different approach
    const indefiniteCommands = [
      'npm start', 'npm run dev', 'npm run serve',
      'yarn start', 'yarn dev', 'yarn serve',
      'node server', 'python app.py', 'flask run',
      'ng serve', 'react-scripts start'
    ];
    
    const isLikelyIndefinite = indefiniteCommands.some(pattern => 
      cmd.startsWith(pattern) || cmd.includes(` ${pattern}`)
    );
    
    // For commands likely to run indefinitely, use spawn with manual timeout
    if (isLikelyIndefinite) {
      console.log(chalk.gray(`  Note: This command might run indefinitely. Will capture output for ${timeout/1000}s.`));
      
      // Use spawn to capture real-time output
      const { spawn } = require('child_process');
      return new Promise(resolve => {
        let outputBuffer = '';
        let errorOccurred = false;
        
        // Split command into executable and args
        const parts = cmd.split(' ');
        const executable = parts[0];
        const args = parts.slice(1);
        
        // Spawn the process
        const childProcess = spawn(executable, args, {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        // Capture stdout
        childProcess.stdout.on('data', (data) => {
          const chunk = data.toString();
          outputBuffer += chunk;
          
          // Check for error patterns in real-time
          if (chunk.toLowerCase().includes('error') || 
              chunk.toLowerCase().includes('failed') ||
              chunk.toLowerCase().includes('exception')) {
            errorOccurred = true;
          }
        });
        
        // Capture stderr
        childProcess.stderr.on('data', (data) => {
          const chunk = data.toString();
          outputBuffer += chunk;
          errorOccurred = true;
        });
        
        // Handle process completion
        childProcess.on('close', (code) => {
          resolve({
            ok: code === 0 && !errorOccurred,
            output: outputBuffer,
            timedOut: false
          });
        });
        
        // Set timeout to kill the process
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGTERM');
            
            // Wait a moment for any final output
            setTimeout(() => {
              resolve({
                ok: !captureTimeoutAsError && !errorOccurred,
                output: outputBuffer + '\n[Command timed out after ' + (timeout/1000) + ' seconds]',
                timedOut: true
              });
            }, 500);
          }
        }, timeout);
      });
    }
    
    // For normal commands, use execSync with timeout
    const out = execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout });
    return { ok: true, output: out, timedOut: false };
  } catch (e) {
    // Check if this was a timeout
    const wasTimeout = e.signal === 'SIGTERM' || e.message.includes('timeout');
    
    return { 
      ok: false, 
      output: e.stdout?.toString() || e.message,
      timedOut: wasTimeout
    };
  }
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
  
  const content = historyArr.map((iteration, i) => {
    return `=== ITERATION ${i + 1} ===\n\n` +
           `ERROR:\n${iteration.error}\n\n` +
           `ANALYSIS:\n${iteration.analysis}\n\n` +
           `PATCH:\n${iteration.patch}\n\n` +
           '='.repeat(50) + '\n\n';
  }).join('');
  
  await fs.writeFile(logPath, content, 'utf8');
} 