/**
 * Error Traceback Analysis Module
 * 
 * Provides utilities for analyzing error logs, extracting file paths and line numbers,
 * and displaying relevant code snippets. This module is crucial for error diagnosis,
 * as it locates and highlights the code sections where errors originate, providing
 * essential context for both users and the LLM analysis functions.
 */

import { existsSync } from 'fs';
import { runCommand } from './cliTools.js'; // Updated import path
import boxen from 'boxen';
import { BOX } from '../ui/terminalUI.js';
import { basename } from 'path';
import { echoCommand, truncateOutput} from '../ui/terminalUI.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

/* ───────────────────────────── User File Check ────────────────────────── */
/**
 * Checks if a given file path likely belongs to user code rather than system/library code.
 * Used to filter traceback entries to focus on relevant files.
 * @param {string} p - The file path to check.
 * @returns {boolean} - True if the path seems to be user code.
 */
export function isUserFile(p) {
  // If path doesn't exist or isn't a file, it's not a user file
  if (!existsSync(p)) {
    return false;
  }
  
  try {
    // Get absolute path and normalize it
    const absolutePath = path.resolve(p);
    
    // Directories to skip (common system/package locations)
    const skip = [
      // Python
      'site-packages', 'dist-packages', 'lib/python',
      // JavaScript/Node.js
      'node_modules', 'npm', 'yarn',
      // System paths
      '/usr/lib/', '/usr/local/lib/', '/var/lib/', '/opt/',
      '/Library/Frameworks/', '/System/', '/Applications/',
      // Special paths
      '<frozen', '<string>', '__pycache__', '<__array_function__>',
      // Common package managers
      '.nvm/', '.cargo/', '.gem/', '.conda/',
      // Ruby
      'gems/', 'ruby/gems',
      // Java
      'jre/', 'jdk/', '.m2/', 'gradle/',
      // Go
      'go/pkg/', '.go/pkg/',
      // Rust
      '.rustup/', 'cargo/registry/'
    ];
    
    const low = absolutePath.toLowerCase();
    
    // Check if the path contains any of the skip directories
    if (skip.some(dir => low.includes(dir.toLowerCase()))) {
      return false;
    }
    
    // Check if it's in current working directory or subdirectory
    const cwd = process.cwd();
    if (absolutePath.startsWith(cwd)) {
      return true;
    }
    
    // Check if it's a common temp directory
    if (low.includes('/tmp/') || low.includes('/temp/')) {
      return false;
    }
    
    // Check if the file has a standard code extension
    const codeExtensions = [
      '.js', '.py', '.rb', '.java', '.c', '.cpp', '.go', '.rs',
      '.php', '.html', '.css', '.sh', '.json', '.yaml', '.yml',
      '.jsx', '.tsx', '.ts', '.md', '.txt'
    ];
    
    return codeExtensions.some(ext => low.endsWith(ext));
    
  } catch (error) {
    // If any error occurs during the checks, assume it's not a user file
    return false;
  }
}

/* ───────────────────────────── Extract Traceback Files ────────────────────────── */
/**
 * Parses a log string (typically stderr output) to extract file paths and line numbers
 * from various language traceback formats. Filters for user files.
 * @param {string} log - The log output containing tracebacks.
 * @returns {Map<string, number>} - A map of user file paths to the most relevant line number found.
 */
export function extractFilesFromTraceback(log) {
  const result = new Map();
  
  // First, check if this is a user-provided error with priority markers
  const hasPriority1 = log.includes('--- PRIORITY 1: USER PROVIDED CONTEXT ---');
  let userProvidedContext = '';
  
  if (hasPriority1) {
    // Extract user provided context to prioritize it for file extraction
    const userContentMatch = log.match(/--- PRIORITY 1: USER PROVIDED CONTEXT ---\n([\s\S]*?)(?=\n---|$)/m);
    if (userContentMatch && userContentMatch[1]) {
      userProvidedContext = userContentMatch[1].trim();
      console.log(chalk.gray('  Prioritizing user-provided context for file extraction...'));
      
      // Apply all patterns to user input first to ensure it gets priority
      applyPatternsToContent(userProvidedContext, result);
    }
  }
  
  // Pattern matchers for different programming language traceback formats
  const patterns = [
    // Python-style traceback: File "path", line number
    { regex: /File \"([^\"]+)\", line (\d+)/g, fileGroup: 1, lineGroup: 2 },
    
    // JavaScript/Node.js traceback: at module (path:line:column)
    { regex: /at\s+(?:\w+\s+)?\(?([^()\s]+):(\d+)(?::\d+)?\)?/g, fileGroup: 1, lineGroup: 2 },
    
    // Ruby-style traceback: path:line:in `method'
    { regex: /([^:\s]+):(\d+):in/g, fileGroup: 1, lineGroup: 2 },
    
    // Golang-style traceback: path:line +0xabcdef
    { regex: /([^:\s]+):(\d+)\s+\+0x[a-f0-9]+/g, fileGroup: 1, lineGroup: 2 },
    
    // Java/JVM-style traceback: at package.Class.method(Class.java:line)
    { regex: /at\s+[\w$.]+\(([^:)]+):(\d+)\)/g, fileGroup: 1, lineGroup: 2 },
    
    // Browser bundle.js references
    { regex: /@(http:\/\/localhost:[0-9]+\/static\/js\/[^:]+):(\d+):(\d+)/g, fileGroup: 1, lineGroup: 2 },
    
    // Generic path:line pattern that might appear in various errors
    { regex: /\b((?:\/[^\/\s:]+)+\.[a-zA-Z0-9]+):(\d+)/g, fileGroup: 1, lineGroup: 2 },
    
    // Common file extensions mentioned in errors
    { regex: /\b([\w-]+\.(js|jsx|ts|tsx|py|rb|java|go|php|html|css))\b/g, fileGroup: 1, lineGroup: null }
  ];
  
  /**
   * Helper function to apply all patterns to a specific content
   * @param {string} content - Content to search for file patterns
   * @param {Map} resultMap - Map to store results
   */
  function applyPatternsToContent(content, resultMap) {
    // Apply all patterns to this content
    for (const pattern of patterns) {
      let match;
      const { regex, fileGroup, lineGroup } = pattern;
      
      // Reset the regex for each iteration
      regex.lastIndex = 0;
      
      while ((match = regex.exec(content)) !== null) {
        const file = match[fileGroup];
        // If lineGroup is null, use 1 as default line number
        const line = lineGroup ? parseInt(match[lineGroup], 10) : 1;
        
        // Skip if we couldn't parse the line number when it's required
        if (lineGroup && isNaN(line)) continue;
        
        // Add to results
        resultMap.set(file, line);
      }
    }
  }
  
  // Collect frames for each pattern
  const allFrames = [];
  
  for (const pattern of patterns) {
    let match;
    const { regex, fileGroup, lineGroup } = pattern;
    
    // Reset the regex for each iteration
    regex.lastIndex = 0;
    
    while ((match = regex.exec(log)) !== null) {
      const file = match[fileGroup];
      const line = parseInt(match[lineGroup], 10);
      
      // Skip if we couldn't parse the line number
      if (isNaN(line)) continue;
      
      // Store position in the log to determine depth in stack trace
      allFrames.push({ file, line, position: match.index });
    }
  }
  
  // Sort by position in the trace (deeper frames appear first in the trace)
  allFrames.sort((a, b) => a.position - b.position);
  
  // Filter to user files only
  const userFrames = allFrames.filter(frame => isUserFile(frame.file));
  
  // If we have user frames, process them to get the deepest frame for each file
  if (userFrames.length > 0) {
    // Group by file path
    const fileGroups = {};
    for (const frame of userFrames) {
      if (!fileGroups[frame.file]) {
        fileGroups[frame.file] = [];
      }
      fileGroups[frame.file].push(frame);
    }
    
    // For each file, get the deepest frame (last in the stack trace)
    for (const file in fileGroups) {
      const frames = fileGroups[file];
      // The last frame in the group is typically the actual error line
      const deepestFrame = frames[frames.length - 1];
      result.set(file, deepestFrame.line);
    }
  }
  
  return result;
}

/* ───────────────────────────── Read File Context ────────────────────────── */
/**
 * Reads and formats a section of a file around a specific line number.
 * Used to provide context around errors identified in tracebacks.
 * @param {string} file - The path to the file.
 * @param {number} line - The central line number.
 * @param {number} [ctx=30] - The number of lines to include before and after the target line.
 * @returns {string} - Raw code snippet from the file.
 */
export function readFileContext(file, line, ctx = 30) {
  const start = Math.max(1, line - ctx);
  const end   = line + ctx;
  const cmd   = `sed -n '${start},${end}p' ${file}`; // sed is faster than cat

  const { ok, output } = runCommand(cmd, 5_000);
  if (!ok) return { content: `Error reading ${file}: ${output.trim()}`, start: 0, end: 0 };

  return { content: output, start, end };
}

/* ───────────────────────────── Build Error Context ────────────────────────── */
/**
 * Builds a consolidated code context string based on files extracted from a traceback log.
 * @param {string} log - The error log containing tracebacks.
 * @param {number} [contextSize=30] - The number of lines to include before and after each error line.
 * @param {boolean} [includeHeaders=true] - Whether to include file path and line number headers.
 * @returns {string} - A string containing formatted code snippets from relevant files,
 *                     or an empty string if no user files are found in the traceback.
 */
export function buildErrorContext(log, contextSize = 30, includeHeaders = true) {
  const files = extractFilesFromTraceback(log);
  if (!files.size) return '';
  
  const ctx = [];
  for (const [file, line] of files) {
    if (includeHeaders) {
      ctx.push(`\n--- ${file} (line ${line}) ---`);
    }
    const fileContext = readFileContext(file, line, contextSize);
    ctx.push(fileContext.content);
  }
  
  return ctx.join('\n');
}

/* ───────────────────────────── Show Code Snippet ────────────────────────── */
/**
 * Displays a code snippet from a file around a specific line, fetched using `sed`.
 * Shows only the error line plus one line before and after.
 * @param {string} file - Path to the file.
 * @param {number} line - Target line number.
 * @param {number} [ctx=1] - Lines of context before and after (default is 1).
 */
export async function showSnippet(file, line, ctx = 30) {
  const start = Math.max(1, line - ctx), end = line + ctx;
  const cmd   = `sed -n '${start},${end}p' ${basename(file)}`;
  console.log(chalk.gray(`  Retrieving file context ${basename(file)}...`));
  await echoCommand(cmd);
  const { ok, output } = runCommand(cmd, 5000);
  // Not using readFileContext here as we want to run the command directly for output display
}

/* ───────────────────────────── Display Error Snippets ────────────────────────── */
/**
 * Iterates through files identified in an error log's traceback and displays
 * relevant code snippets using `showSnippet`.
 * @param {string} log - The error log content.
 */
export async function displaySnippetsFromError(log) {
  for (const [file, line] of extractFilesFromTraceback(log)) {
    await showSnippet(file, line);
  }
}

/**
 * Extracts the exact line of code where the error occurs.
 * @param {string} file - Path to the file containing the error.
 * @param {number} line - Line number where the error occurs.
 * @returns {string} - The exact line of code that has the error.
 */
export function extractErrorLine(file, line) {
  const cmd = `sed -n '${line}p' ${file}`;
  const { ok, output } = runCommand(cmd, 1000);
  if (!ok || !output.trim()) {
    return `Unable to read line ${line} from ${file}`;
  }
  return output.trim();
}

/**
 * Gets all error lines from files mentioned in a traceback.
 * @param {string} log - The error log containing tracebacks.
 * @returns {string} - A string with all error lines, one per line.
 */
export function getErrorLines(log) {
  const files = extractFilesFromTraceback(log);
  if (!files.size) return '';
  
  const errorLines = [];
  for (const [file, line] of files) {
    errorLines.push(extractErrorLine(file, line));
  }
  
  return errorLines.join('\n');
} 