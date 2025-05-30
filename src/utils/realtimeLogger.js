/**
 * Real-time Command Logger Utility
 * 
 * Provides a command-line utility that can wrap any command to capture
 * its real-time output, including handling Ctrl+C interruptions.
 * This is useful for commands that aren't automatically detected by
 * the terminal logger or for manual debugging sessions.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getTerminalLogPath } from './terminalLogger.js';

/**
 * Wraps a command with real-time logging
 * @param {string} command - The command to execute
 * @param {string[]} args - Command arguments
 * @param {object} options - Execution options
 * @returns {Promise<number>} Exit code of the command
 */
export async function wrapCommandWithLogging(command, args = [], options = {}) {
  const sessionId = `${Date.now()}_${process.pid}`;
  const sessionLogPath = join(homedir(), '.cloi', `session_${sessionId}.log`);
  const terminalLogPath = getTerminalLogPath();
  
  // Ensure log directory exists
  const logDir = join(homedir(), '.cloi');
  if (!existsSync(logDir)) {
    await fs.mkdir(logDir, { recursive: true });
  }
  
  // Create session log with header
  const fullCommand = [command, ...args].join(' ');
  const header = [
    '===================================================',
    `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] COMMAND: ${fullCommand}`,
    `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] DIRECTORY: ${process.cwd()}`,
    `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] SESSION: ${sessionId}`,
    `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] REAL-TIME CAPTURE: ENABLED`,
    `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] OUTPUT BEGINS BELOW:`,
    '---------------------------------------------------'
  ].join('\n') + '\n';
  
  await fs.writeFile(sessionLogPath, header);
  
  return new Promise((resolve) => {
    // Spawn the process
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
      ...options
    });
    
    let interrupted = false;
    
    // Handle Ctrl+C
    const handleInterrupt = async () => {
      if (!interrupted) {
        interrupted = true;
        const interruptMsg = `\n[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] === INTERRUPTED BY USER (Ctrl+C) ===\n`;
        await fs.appendFile(sessionLogPath, interruptMsg);
        
        // Kill the child process
        child.kill('SIGINT');
        
        // Give it a moment to clean up
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }
    };
    
    // Set up signal handlers
    process.on('SIGINT', handleInterrupt);
    process.on('SIGTERM', handleInterrupt);
    
    // Capture stdout
    child.stdout.on('data', async (data) => {
      const output = data.toString();
      process.stdout.write(output); // Show to user
      await fs.appendFile(sessionLogPath, output); // Log to file
    });
    
    // Capture stderr
    child.stderr.on('data', async (data) => {
      const output = data.toString();
      process.stderr.write(output); // Show to user
      await fs.appendFile(sessionLogPath, output); // Log to file
    });
    
    // Handle process completion
    child.on('close', async (code, signal) => {
      // Remove signal handlers
      process.removeListener('SIGINT', handleInterrupt);
      process.removeListener('SIGTERM', handleInterrupt);
      
      // Determine exit status
      let exitStatus = code;
      if (signal) {
        exitStatus = signal === 'SIGINT' ? 130 : 1;
      }
      
      // Add footer to session log
      const footer = [
        '---------------------------------------------------',
        `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] EXIT STATUS: ${exitStatus}`,
        `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] SESSION ENDED`,
        '===================================================\n\n'
      ].join('\n');
      
      await fs.appendFile(sessionLogPath, footer);
      
      // Merge session log to main terminal log
      try {
        const sessionContent = await fs.readFile(sessionLogPath, 'utf8');
        await fs.appendFile(terminalLogPath, sessionContent);
        
        // Clean up session log
        await fs.unlink(sessionLogPath);
      } catch (error) {
        console.error(`Warning: Failed to merge session log: ${error.message}`);
      }
      
      resolve(exitStatus);
    });
    
    // Handle spawn errors
    child.on('error', async (error) => {
      const errorMsg = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ERROR: ${error.message}\n`;
      await fs.appendFile(sessionLogPath, errorMsg);
      
      // Remove signal handlers
      process.removeListener('SIGINT', handleInterrupt);
      process.removeListener('SIGTERM', handleInterrupt);
      
      resolve(1);
    });
  });
}

/**
 * CLI wrapper for the real-time logger
 * Usage: node realtimeLogger.js <command> [args...]
 */
export async function cliWrapper() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: cloi-wrap <command> [args...]');
    console.error('');
    console.error('Examples:');
    console.error('  cloi-wrap npm start');
    console.error('  cloi-wrap python manage.py runserver');
    console.error('  cloi-wrap node server.js');
    console.error('  cloi-wrap rails server');
    process.exit(1);
  }
  
  const [command, ...commandArgs] = args;
  
  console.log(`🔍 CLOI: Wrapping command with real-time logging: ${command} ${commandArgs.join(' ')}`);
  console.log('📝 Output will be captured to terminal logs');
  console.log('⚡ Press Ctrl+C to interrupt and capture the interruption\n');
  
  try {
    const exitCode = await wrapCommandWithLogging(command, commandArgs);
    process.exit(exitCode);
  } catch (error) {
    console.error(`Error executing command: ${error.message}`);
    process.exit(1);
  }
}

// If this file is run directly, execute the CLI wrapper
if (import.meta.url === `file://${process.argv[1]}`) {
  cliWrapper();
} 