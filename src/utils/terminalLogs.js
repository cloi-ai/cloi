/**
 * Terminal Logs Module
 * 
 * Provides utilities for reading and analyzing terminal logs.
 * This module is used to extract recent errors from terminal logs,
 * which helps the application diagnose issues without re-running commands.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getTerminalLogPath } from './terminalLogger.js';

/**
 * Read recently logged terminal output
 * @param {number} [maxLines=1000] Maximum number of lines to read
 * @returns {Promise<string>} Terminal log content
 */
export async function readTerminalLogs(maxLines = 1000) {
  const terminalLogPath = getTerminalLogPath();
  
  if (!existsSync(terminalLogPath)) {
    return '';
  }
  
  try {
    // Read the file and get the last maxLines lines
    const content = await fs.readFile(terminalLogPath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch (error) {
    console.error(`Error reading terminal logs: ${error.message}`);
    return '';
  }
}

/**
 * Determines if a log excerpt likely contains a runtime error
 * @param {string} log Log content to analyze
 * @returns {boolean} True if the log appears to contain a runtime error
 */
export function isLikelyRuntimeError(log) {
  const errorPatterns = [
    /error/i,
    /exception/i,
    /traceback/i,
    /fail/i,
    /crash/i,
    /stack trace/i,
    /warning/i,
    // Django-specific patterns
    /Internal Server Error/i,
    /ImportError/i,
    /ModuleNotFoundError/i,
    /subprocess\.CalledProcessError/i,
    // Common Python error patterns
    /File ".*", line \d+/,
    /^\s+File/m,
    // HTTP error patterns
    /HTTP\/1\.1" 5\d\d/,
    // General error indicators
    /returned non-zero exit status/i,
    /broken pipe/i,
  ];
  
  return errorPatterns.some(pattern => pattern.test(log));
}

/**
 * Extract the most recent error from terminal logs
 * @returns {Promise<{error: string, files: Map<string, number>, wasInterrupted: boolean}>} Extracted error and related files
 */
export async function extractRecentError() {
  const logs = await readTerminalLogs(1500); // Increase lines to capture longer error blocks
  
  // No logs available
  if (!logs) {
    return { error: '', files: new Map(), wasInterrupted: false };
  }
  
  // Split into "command blocks" using the consistent separator
  // Each block starts with the separator and contains command info and output
  const commandBlocks = logs.split("===================================================\n")
    .filter(block => block.trim() !== "" && block.includes("COMMAND:"));
  
  // Look through recent command blocks for errors, starting from the most recent
  // Special handling for Ctrl+C scenarios with multiple blocks
  for (let i = commandBlocks.length - 1; i >= Math.max(0, commandBlocks.length - 3); i--) {
    const block = commandBlocks[i];
    
    // Check if this was an interrupted command
    const wasInterrupted = block.includes("=== INTERRUPTED BY USER (Ctrl+C) ===") || 
                          block.includes("EXIT STATUS: 130");
    
    // Extract the part of the block that is the actual command output
    const outputHeader = "OUTPUT BEGINS BELOW:\n---------------------------------------------------\n";
    const outputStartIndex = block.indexOf(outputHeader);
    
    if (outputStartIndex !== -1) {
      const outputContent = block.substring(outputStartIndex + outputHeader.length);
      const outputEndMarker = "\n---------------------------------------------------\n"; // Before EXIT STATUS
      const outputEndIndex = outputContent.indexOf(outputEndMarker);
      const pureOutput = (outputEndIndex !== -1) ? 
                        outputContent.substring(0, outputEndIndex) : 
                        outputContent;
      
      // For interrupted commands, check if this block has substantial error content
      if (wasInterrupted) {
        // Skip blocks that are nearly empty (just "Watching for file changes" or similar)
        const contentLines = pureOutput.trim().split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed && 
                 !trimmed.startsWith('Watching for file changes') &&
                 !trimmed.match(/^\[[0-9\/]+\s+[0-9:]+\]\s*===\s*INTERRUPTED/);
        });
        
        // If this block has substantial content (more than 3 meaningful lines), use it
        // OR if it contains obvious error patterns
        if (contentLines.length > 3 || isLikelyRuntimeError(pureOutput)) {
          // Import the traceback analyzer
          const { extractFilesFromTraceback } = await import('./traceback.js');
          const files = extractFilesFromTraceback(pureOutput);
          
          return {
            error: pureOutput,
            files: files,
            wasInterrupted: true
          };
        }
        
        // If this is a nearly empty interrupted block, continue to check previous blocks
        // This handles the case where user pressed Ctrl+C twice
        continue;
      }
      
      // For non-interrupted commands, use existing error detection logic
      if (isLikelyRuntimeError(pureOutput)) {
        // Import the traceback analyzer
        const { extractFilesFromTraceback } = await import('./traceback.js');
        const files = extractFilesFromTraceback(pureOutput);
        
        return {
          error: pureOutput,
          files: files,
          wasInterrupted: false
        };
      }
    }
  }
  
  return { error: '', files: new Map(), wasInterrupted: false };
} 