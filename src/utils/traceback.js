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
  // If path doesn't exist or isn't a file, check if it could be a user file anyway
  // (sometimes error messages reference files before they're created)
  let shouldCheckExistence = true;
  
  try {
    // Get absolute path and normalize it
    let absolutePath;
    try {
      absolutePath = path.resolve(p);
    } catch (error) {
      // If path resolution fails, use the original path
      absolutePath = p;
      shouldCheckExistence = false;
    }
    
    // Directories to skip (common system/package locations)
    const skip = [
      // Python
      'site-packages', 'dist-packages', 'lib/python', '__pycache__',
      // JavaScript/Node.js
      'node_modules', 'npm', 'yarn', '.npm', '.yarn',
      // System paths (Unix/Linux/macOS)
      '/usr/lib/', '/usr/local/lib/', '/var/lib/', '/opt/',
      '/Library/Frameworks/', '/System/', '/Applications/',
      '/usr/bin/', '/usr/local/bin/', '/bin/', '/sbin/',
      // Common package managers and tools
      '.nvm/', '.cargo/', '.gem/', '.conda/', '.pip/',
      // Ruby
      'gems/', 'ruby/gems', '.rvm/',
      // Java
      'jre/', 'jdk/', '.m2/', 'gradle/', '.gradle/',
      // Go
      'go/pkg/', '.go/pkg/', 'GOPATH/', 'GOROOT/',
      // Rust
      '.rustup/', 'cargo/registry/',
      // Package managers
      '.cache/', 'cache/', 'Cache/',
      // Special paths that aren't real files
      '<frozen', '<string>', '<__array_function__>', '<stdin>', '<stdout>',
      // Common virtual/temporary locations
      '/tmp/', '/temp/', 'tmp/', 'temp/',
      // Editor and IDE files
      '.vscode/', '.idea/', '.vs/',
      // Version control
      '.git/', '.svn/', '.hg/',
      // Build directories
      'build/', 'dist/', 'target/', 'out/', 'bin/', 'obj/',
      // Package lock files and configs that aren't user code
      'package-lock.json', 'yarn.lock', 'composer.lock'
    ];
    
    const low = absolutePath.toLowerCase();
    
    // Check if the path contains any of the skip directories
    if (skip.some(dir => {
      const skipLower = dir.toLowerCase();
      return low.includes(skipLower) || 
             low.includes('/' + skipLower) || 
             low.endsWith('/' + skipLower.replace('/', ''));
    })) {
      return false;
    }
    
    // Skip files that look like internal or generated files
    const filename = path.basename(absolutePath).toLowerCase();
    const skipFilenames = [
      // Internal files
      '__init__.py', '__main__.py', '__pycache__',
      // Lock/cache files
      '.ds_store', 'thumbs.db', 
      // Build artifacts
      'bundle.js', 'bundle.min.js',
      // Log files
      '.log', 'error.log', 'access.log'
    ];
    
    if (skipFilenames.some(skip => filename.includes(skip))) {
      return false;
    }
    
    // Check file extension - expand to include more user file types
    const codeExtensions = [
      // Programming languages
      '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
      '.py', '.pyx', '.pyi', '.ipynb',
      '.rb', '.rbw', '.rake',
      '.java', '.scala', '.kt', '.groovy',
      '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
      '.go', '.rs', '.zig',
      '.php', '.phtml',
      '.swift', '.m', '.mm',
      '.dart', '.r', '.jl',
      // Web technologies
      '.html', '.htm', '.css', '.scss', '.sass', '.less',
      '.vue', '.svelte', '.astro',
      // Configuration and data
      '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.xml', '.plist',
      // Scripts and shell
      '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
      // Documentation and text
      '.md', '.mdx', '.rst', '.txt', '.rtf',
      // Database and query
      '.sql', '.graphql', '.gql',
      // Other common user files
      '.env', '.properties', '.gitignore', '.dockerignore',
      'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'requirements.txt'
    ];
    
    const hasCodeExtension = codeExtensions.some(ext => {
      return low.endsWith(ext.toLowerCase()) || 
             filename === ext.substring(1); // Handle files like "Dockerfile"
    });
    
    if (!hasCodeExtension) {
      return false;
    }
    
    // If we should check existence and the file doesn't exist, it might still be relevant
    // (e.g., import errors referencing missing files in user space)
    if (shouldCheckExistence && !existsSync(absolutePath)) {
      // If it's in a path that looks like user space, consider it valid
      const cwd = process.cwd();
      const userHome = require('os').homedir();
      
      // Check if it's in current working directory tree or user home tree (but not system areas)
      if (absolutePath.startsWith(cwd) || 
          (absolutePath.startsWith(userHome) && 
           !absolutePath.includes('/Library/') && 
           !absolutePath.includes('/.cache/') &&
           !absolutePath.includes('/node_modules/'))) {
        return true;
      }
      
      return false;
    }
    
    // If file exists, check if it's in a user-controlled location
    if (shouldCheckExistence) {
      const cwd = process.cwd();
      const userHome = require('os').homedir();
      
      // Check if it's in current working directory or subdirectory
      if (absolutePath.startsWith(cwd)) {
        return true;
      }
      
      // Check if it's in user home directory (but not in system areas)
      if (absolutePath.startsWith(userHome)) {
        // Exclude common system areas in user home
        const userSystemPaths = [
          '/Library/', '/.cache/', '/.npm/', '/.yarn/', '/.cargo/',
          '/.conda/', '/.gem/', '/.pip/', '/.rustup/', '/.nvm/'
        ];
        
        const relativePath = absolutePath.substring(userHome.length);
        if (!userSystemPaths.some(sysPath => relativePath.startsWith(sysPath))) {
          return true;
        }
      }
    }
    
    return hasCodeExtension;
    
  } catch (error) {
    // If any error occurs during the checks, be conservative
    // but still allow files with obvious code extensions
    const filename = path.basename(p).toLowerCase();
    return filename.endsWith('.js') || filename.endsWith('.py') || 
           filename.endsWith('.ts') || filename.endsWith('.jsx') ||
           filename.endsWith('.tsx') || filename.endsWith('.vue') ||
           filename.endsWith('.java') || filename.endsWith('.rb');
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
  
  // Pattern matchers for different programming language traceback formats
  const patterns = [
    // Traditional traceback patterns (highest priority)
    { regex: /File \"([^\"]+)\", line (\d+)/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    { regex: /at\s+(?:\w+\s+)?\(?([^()\s]+):(\d+)(?::\d+)?\)?/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    { regex: /([^:\s]+):(\d+):in/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    { regex: /([^:\s]+):(\d+)\s+\+0x[a-f0-9]+/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    { regex: /at\s+[\w$.]+\(([^:)]+):(\d+)\)/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    { regex: /\b((?:\/[^\/\s:]+)+\.[a-zA-Z0-9]+):(\d+)/g, fileGroup: 1, lineGroup: 2, priority: 1 },
    
    // File URLs (medium priority)
    { regex: /file:\/\/\/([^?\s'"]+\.[a-zA-Z0-9]+)/g, fileGroup: 1, lineGroup: -1, priority: 2 },
    
    // Error/warning messages with file mentions (lower priority)
    { regex: /(?:Error|Warning|Notice)[^:]*:\s*[^]*?([A-Za-z]:?[\/\\][^?\s:;,'"()<>]+\.[a-zA-Z0-9]+)/g, fileGroup: 1, lineGroup: -1, priority: 3 },
    
    // Module errors
    { regex: /(?:Cannot\s+(?:find|resolve)|Module\s+[^\/]*|Failed\s+to\s+[^\/]*)\s+(?:module\s+)?['"`]?([^'"`\s:;,()]+\.[a-zA-Z0-9]+)['"`]?/g, fileGroup: 1, lineGroup: -1, priority: 4 },
    
    // Files in parentheses
    { regex: /\(([^()\s:;,'"]+\.[a-zA-Z0-9]+)\)/g, fileGroup: 1, lineGroup: -1, priority: 5 }
  ];
  
  // Collect frames for each pattern with priority
  const allFrames = [];
  
  for (const pattern of patterns) {
    let match;
    const { regex, fileGroup, lineGroup, priority } = pattern;
    
    regex.lastIndex = 0;
    
    while ((match = regex.exec(log)) !== null) {
      let file = match[fileGroup];
      let line = 1;
      
      // Clean up file URLs
      if (file.startsWith('file:///')) {
        file = file.replace(/^file:\/\/\//, '/');
      }
      
      // Normalize path separators
      file = file.replace(/\\/g, '/');
      
      // Parse line number if available
      if (lineGroup > 0) {
        line = parseInt(match[lineGroup], 10);
        if (isNaN(line)) continue;
      }
      
      allFrames.push({ 
        file: file, 
        line: line, 
        position: match.index, 
        priority: priority,
        originalMatch: match[0] 
      });
    }
  }
  
  // Sort by priority first, then by position
  allFrames.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.position - b.position;
  });
  
  // Filter to user files and deduplicate
  const seenFiles = new Set();
  const seenBasePaths = new Map(); // Track basename + parent directory combinations
  
  for (const frame of allFrames) {
    if (isUserFile(frame.file)) {
      // Create a normalized key for deduplication
      let normalizedPath = frame.file;
      
      // Try to resolve to absolute path for deduplication
      try {
        if (path.isAbsolute(normalizedPath)) {
          normalizedPath = path.normalize(normalizedPath);
        } else {
          normalizedPath = path.resolve(normalizedPath);
        }
      } catch (error) {
        // Keep original if normalization fails
      }
      
      // Create a deduplication key based on basename and parent directory
      const basename = path.basename(normalizedPath);
      const parentDir = path.basename(path.dirname(normalizedPath));
      const dedupeKey = `${parentDir}/${basename}`;
      
      // Check if we've already seen this basename + parent directory combination
      if (!seenBasePaths.has(dedupeKey)) {
        seenBasePaths.set(dedupeKey, normalizedPath);
        result.set(normalizedPath, frame.line);
        
        // For the main file we want, take the first valid match and stop
        if (result.size >= 3) break; // Limit to avoid too many false positives
      }
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