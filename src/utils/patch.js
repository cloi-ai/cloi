/**
 * Patch Generation and Application Module
 * 
 * Provides utilities for creating, extracting, displaying, and applying code patches.
 * This module handles the core functionality of generating unified diff patches and
 * safely applying them to the codebase. It includes robust error handling and fallback 
 * mechanisms to ensure patches can be applied successfully across different environments.
 */

import { execSync, spawnSync } from 'child_process';
import { askYesNo } from '../ui/terminalUI.js';
import chalk from 'chalk';
import boxen from 'boxen';
import { BOX } from '../ui/terminalUI.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';


/* ───────────────────────── Directory Creation Helper ────────────────────────────── */
async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

/* ───────────────────────── Git Repository Detection ────────────────────────────── */
function inGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── Patch Level Detection ────────────────────────────── */
function detectStripLevel(firstPath) {
  if (firstPath.startsWith('/')) return 0;      // absolute → keep whole path
  if (firstPath.startsWith('a/'))  return 1;    // git-style a/ b/
  return 0;                                     // plain relative file
}

/* ────────────────────────────── Show Patch ─────────────────────────────────── */
/**
 * Displays a diff/patch in a formatted way.
 * @param {string} diff - The diff/patch text to display.
 */
export function showPatch(diff) {
  // Check if the diff has proper hunk headers, add if missing
  if (diff.includes('---') && diff.includes('+++') && !diff.includes('@@')) {
    // Simple heuristic to add hunk headers if missing
    const lines = diff.split('\n');
    let headerEndIndex = -1;
    
    // Find where the header ends (after +++ line)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('+++')) {
        headerEndIndex = i + 1;
        break;
      }
    }
    
    // If we found the header end and there are changes after it
    if (headerEndIndex >= 0 && headerEndIndex < lines.length) {
      // Simple header with line 1 and appropriate context
      const hunkHeader = '@@ -1,1 +1,1 @@';
      lines.splice(headerEndIndex, 0, hunkHeader);
      diff = lines.join('\n');
    }
  }
  
  // Colorize diff: '+' lines are green, '-' lines are red
  const colorizedDiff = diff.split('\n').map(line => {
    if (line.startsWith('+')) {
      return chalk.green(line);
    } else if (line.startsWith('-')) {
      return chalk.red(line);
    } else if (line.startsWith('@@')) {
      return chalk.cyan(line);
    } else {
      return line;
    }
  }).join('\n');
  
  console.log(boxen(colorizedDiff.trim() || '(empty diff)', { ...BOX.OUTPUT, title: 'Proposed Patch' }));
}

/* ───────────────────────── Unified Patch Application ────────────────────────────── */
/**
 * Applies a unified diff patch to the codebase.
 * Tries applying the patch using the standard `patch` command with different
 * strip levels (`-p`) for robustness. Falls back to `git apply --3way` if
 * inside a Git repository and initial attempts fail.
 * @param {string} diff - The unified diff content.
 * @param {string} [cwd=process.cwd()] - The working directory where paths are relative to.
 * @throws {Error} If the patch command fails after all attempts.
 */
function applyPatch(diff, cwd = process.cwd()) {
  // 1) Normalise line endings
  diff = diff.replace(/\r\n/g, '\n');

  // 2) Remove Git metadata lines that confuse patch(1)
  diff = diff.replace(/^index [0-9a-f]+\.\.[0-9a-f]+ [0-9]+$/gm, '');
  diff = diff.replace(/^diff --git .+$/gm, '');

  // 3) Ensure long header lines aren't wrapped
  diff = diff.replace(/^(---|\+\+\+)\s+([^\n]+)\n[ \t]+([^\n]+)/gm,
    (_, pfx, a, b) => `${pfx} ${a}${b}`);

  // 4) Quick fix: add missing "+" to comment lines inside hunks
  diff = fixMissingCommentPlusSign(diff).diff;

  // 5) Ensure diff ends with a newline
  if (!diff.endsWith('\n')) diff += '\n';

  // 6) Try patch(1) with a range of strip levels.
  //    Paths produced by LLMs can include deep prefixes like
  //    a/Users/<user>/Desktop/…/file.py which require -p3 or -p4.
  //    We therefore try a broader range (0-8) instead of just 0-2.
  const pLevels = Array.from({ length: 9 }, (_, i) => i); // [0,1,2,3,4,5,6,7,8]
  for (const p of pLevels) {
    const res = spawnSync('patch', [
      `-p${p}`, '--batch', '--forward', '--fuzz', '3', '--reject-file=-'
    ], { cwd, input: diff, stdio: ['pipe', 'inherit', 'inherit'] });
    if (res.status === 0) return;   // success
  }

  // 7) Fallback: git apply --3way if inside a repo
  if (inGitRepo()) {
    const git = spawnSync('git', ['apply', '--3way', '--whitespace=nowarn', '-'],
      { cwd, input: diff, stdio: ['pipe', 'inherit', 'inherit'] });
    if (git.status === 0) return;
  }

  throw new Error('Patch command failed');
}

/**
 * Fixes missing + signs on comment lines in the diff
 * @param {string} diff - The diff content to fix
 * @returns {Object} - Object containing fixed diff and whether it was fixed
 */
function fixMissingCommentPlusSign(diff) {
  const lines = diff.split('\n');
  let inHunk = false;
  let wasModified = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if we're in a hunk
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    
    // If we're in a hunk and find a line that looks like a comment
    // but doesn't have a prefix (-, +, or space), assume it should be a + line
    if (inHunk && !line.startsWith('-') && !line.startsWith('+') && !line.startsWith(' ') && line.trim().startsWith('#')) {
      lines[i] = '+ ' + line.trim();
      wasModified = true;
    }
  }
  
  return {
    diff: lines.join('\n'),
    fixed: wasModified
  };
}

/* ───────────────────────── Diff Text Extraction ────────────────────────────── */
/**
 * Extracts the unified diff portion from a larger text that may contain explanations or other text.
 * @param {string} diffText - The text containing a diff.
 * @returns {string} - The cleaned diff text.
 */
export function extractDiff(diffText) {
  // First, check if this is already a clean diff from our structured generation
  if (diffText.trim().startsWith('--- a/') && 
      diffText.includes('\n+++ b/')) {
    return diffText.trim();
  }
  
  // Handle the new format with FINAL DIFF marker
  const finalDiffMatch = diffText.match(/FINAL DIFF\s*([\s\S]+?)(?:```\s*\n\n|$)/i);
  if (finalDiffMatch) {
    // Capture everything after FINAL DIFF but before the closing code block if present
    let diffContent = finalDiffMatch[1].trim();
    
    // Remove any trailing markdown code block markers and text after them
    diffContent = diffContent.replace(/```[\s\S]*$/, '').trim();
    
    return diffContent;
  }

  // Handle markdown code block format with diff language
  const markdownMatch = diffText.match(/```(?:diff)?\n([\s\S]+?)```/);
  if (markdownMatch) {
    const content = markdownMatch[1].trim();
    
    return content;
  }
  
  // Handle plain diff format that might include explanation text
  const diffMatch = diffText.match(/^(---[\s\S]+?(?:\n\+\+\+[\s\S]+?)(?:\n@@[\s\S]+?))/m);
  if (diffMatch) {
    return diffMatch[1].trim();
  }
  
  // If the response already seems to be a clean diff, return it as is
  if (diffText.trim().startsWith('---') && diffText.includes('+++')) {
    // Extract just the unified diff part
    const endOfDiffIndex = diffText.indexOf('```', diffText.indexOf('+++'));
    if (endOfDiffIndex > 0) {
      return diffText.substring(0, endOfDiffIndex).trim();
    }
    
    return diffText.trim();
  }
  
  // Additional handling for specific formats we've seen
  if (diffText.includes('```') && diffText.includes('@@ -')) {
    // Extract the content between the first @@ and the closing ```
    const match = diffText.match(/(@@[\s\S]+?)(?:```|$)/);
    if (match) {
      // Get everything from the file paths before @@ to the match
      const headerMatch = diffText.match(/(---[\s\S]+?\+\+\+[\s\S]+?)(@@)/);
      if (headerMatch) {
        return (headerMatch[1] + match[1]).trim();
      }
      return match[1].trim();
    }
  }
  
  // Fall back to returning as is after trimming
  return diffText.trim();
}

/* ───────────────────────── Patch Confirmation And Apply ────────────────────────────── */
/**
 * Displays a generated patch, asks the user for confirmation, and applies it if confirmed.
 * @param {string} diff - The unified diff patch content.
 * @param {string} [cwd=process.cwd()] - The working directory for applying the patch.
 * @returns {Promise<boolean>} - True if the patch was successfully applied, false otherwise.
 */
export async function confirmAndApply(diff, cwd = process.cwd()) {
  // Display the patch
  showPatch(diff);
  
  // Ask for confirmation
  if (!(await askYesNo('Apply this patch?'))) return false;
  
  try {
    // Apply the patch if confirmed
    applyPatch(diff, cwd);
    console.log(chalk.green('✓ Patch applied\n'));
    return true;
  } catch (e) {
    console.error(chalk.red(`Patch failed: ${e.message}`));
    return false;
  }
}

/* ────────────────────────── Structured Diff Generation ─────────────────────────── */
/**
 * Converts structured patch data to unified diff format
 * @param {Object} patchData - The structured patch data
 * @param {string} currentDir - The current working directory
 * @returns {string} - Unified diff format text
 */
export function convertToUnifiedDiff(patchData, currentDir) {
  // Group changes by file
  const fileChanges = {};
  
  // Normalize structure and handle any string processing before grouping
  patchData.changes.forEach(change => {
    // Normalize the file path
    const filePath = change.file_path;
    
    if (!fileChanges[filePath]) {
      fileChanges[filePath] = [];
    }
    
    // Clone the change to avoid modifying original
    const normalizedChange = { ...change };
    
    // Normalize the change to ensure consistent handling
    // Make sure old_line and new_line are properly stored as single entities
    // even if they contain newlines
    fileChanges[filePath].push(normalizedChange);
  });
  
  // Generate diff for each file
  let diffOutput = '';
  
  for (const [filePath, changes] of Object.entries(fileChanges)) {
    // Sort changes by line number
    changes.sort((a, b) => a.line_number - b.line_number);
    
    // Add file headers with proper relative paths
    // Remove any leading path separators to ensure relative paths
    const cleanFilePath = filePath.replace(/^\/+/, '');
    diffOutput += `--- ${cleanFilePath}\n`;
    diffOutput += `+++ ${cleanFilePath}\n`;
    
    // Generate hunks
    const hunks = generateHunks(changes, filePath);
    diffOutput += hunks;
  }
  
  return diffOutput;
}

/**
 * Generates hunks for a unified diff from a list of changes
 * @param {Array} changes - List of changes for a single file
 * @param {string} filePath - The path of the file being changed
 * @returns {string} - Formatted hunks
 */
function generateHunks(changes, filePath) {
  if (!changes || changes.length === 0) {
    console.log('No changes to process');
    return '';
  }
  
  try {
    // Create separate hunks for each change instead of grouping them
    let output = '';
    
    // Sort changes by line number for consistent ordering
    changes.sort((a, b) => a.line_number - b.line_number);
    
    // Process each change as its own hunk
    changes.forEach(change => {
      const lineNumber = change.line_number;
      
      // Count additions and deletions for this change
      let deletions = (change.old_line && change.old_line.trim()) ? 1 : 0;
      let additions = (change.new_line !== null) ? 1 : 0;
      
      // Make sure we always have valid counts
      if (deletions === 0) deletions = 1;
      if (additions === 0) additions = 1;
      
      // Create the hunk header for this single change
      const hunkHeader = `@@ -${lineNumber},${deletions} +${lineNumber},${additions} @@`;
      output += hunkHeader + '\n';
      
      // Add the change
      if (change.old_line !== undefined && change.old_line !== null) {
        output += processCodeLine(change.old_line, '-', filePath);
      }
      if (change.new_line !== null) {
        output += processCodeLine(change.new_line, '+', filePath);
      }
    });
    
    return output;
  } catch (error) {
    console.log(chalk.red('Error generating hunks:', error.message));
    return ''; // Return empty string on error
  }
}

/**
 * Process a line of code for diff output, handling both literal \n and actual newlines
 * @param {string} codeText - The code text to process
 * @param {string} prefix - The prefix to use (+ or -)
 * @param {string} filePath - The file path for language detection
 * @returns {string} - Formatted diff lines with prefix
 */
function processCodeLine(codeText, prefix, filePath) {
  if (typeof codeText !== 'string') return '';
  
  // Handle both cases: escaped \n sequences and actual newlines in the input
  let lines = [];
  
  // First, split on literal \n sequences
  if (codeText.includes('\\n')) {
    lines = codeText.split('\\n');
  } else if (codeText.includes('\n')) {
    // If not escaped but has actual newlines
    lines = codeText.split('\n');
  } else {
    // Single line
    return prefix + codeText + '\n';
  }
  
  // Get file extension for language detection
  const fileExt = filePath.split('.').pop().toLowerCase();
  
  // Check if this is a string literal that should be preserved as-is
  const isStringLiteral = detectStringLiteral(codeText, fileExt);
  
  // If it's a string literal with \n, preserve it as a single line
  if (isStringLiteral && lines.length > 1 && codeText.includes('\\n')) {
    // This is a string with \n that should be treated as literal in source code
    return prefix + codeText + '\n';
  }
  
  // For normal multi-line scenarios
  // Find indentation of the first line to preserve for subsequent lines
  const indentMatch = lines[0].match(/^(\s+)/);
  const baseIndent = indentMatch ? indentMatch[1] : '';
  
  // Format each line with the appropriate prefix and indentation
  return lines.map((l, i) => {
    // First line keeps original indentation
    if (i === 0) {
      return prefix + l;
    }
    // Subsequent lines get prefix plus base indentation plus content
    return prefix + baseIndent + l;
  }).join('\n') + '\n';
}

/**
 * Detects if text contains a string literal that should preserve \n escapes
 * @param {string} text - The code text to analyze
 * @param {string} fileExt - File extension for language detection
 * @returns {boolean} - Whether this appears to be a string literal
 */
function detectStringLiteral(text, fileExt) {
  // Check for common string patterns based on language
  switch (fileExt) {
    case 'py':
      // Python strings: f-strings, triple quotes, regular quotes
      return (
        text.includes('f"') || text.includes("f'") || 
        text.includes('"""') || text.includes("'''") ||
        (text.includes('"') && text.match(/"/g).length >= 2) ||
        (text.includes("'") && text.match(/'/g).length >= 2)
      );
      
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'cxx':
      // C/C++ strings: double quotes or character literals
      return (
        (text.includes('"') && text.match(/"/g).length >= 2) ||
        (text.includes("'") && text.match(/'/g).length >= 2)
      );
      
    case 'rs':
      // Rust strings: raw strings r"..." or regular strings
      return (
        text.includes('r#"') || 
        text.includes('r"') ||
        (text.includes('"') && text.match(/"/g).length >= 2)
      );
      
    case 'go':
      // Go strings: backtick strings or regular strings
      return (
        text.includes('`') ||
        (text.includes('"') && text.match(/"/g).length >= 2)
      );
      
    case 'js': case 'ts': case 'jsx': case 'tsx':
      // JavaScript/TypeScript: template literals, regular strings
      return (
        text.includes('`') ||
        (text.includes('"') && text.match(/"/g).length >= 2) ||
        (text.includes("'") && text.match(/'/g).length >= 2)
      );
      
    case 'java': case 'kt': case 'scala':
      // Java/Kotlin/Scala strings
      return (
        (text.includes('"') && text.match(/"/g).length >= 2) ||
        (text.includes("'") && text.match(/'/g).length >= 2)
      );
      
    default:
      // General string detection as fallback
      return (
        (text.includes('"') && text.match(/"/g).length >= 2) ||
        (text.includes("'") && text.match(/'/g).length >= 2) ||
        text.includes('`') ||
        text.includes('"""') ||
        text.includes("'''")
      );
  }
} 