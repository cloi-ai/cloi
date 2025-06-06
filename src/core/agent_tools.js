/**
 * Agent Tools Module
 * 
 * Implements all tools available to the agentic debugging assistant.
 * Each tool corresponds to a specific capability the agent can use to
 * diagnose and fix software issues.
 */

import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { join, relative, resolve } from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import { runCommand } from '../utils/cliTools.js';
import { 
  buildErrorContext, 
  extractFilesFromTraceback, 
  getErrorLines, 
  readFileContext,
  displaySnippetsFromError 
} from '../utils/traceback.js';
import { extractDiff, confirmAndApply, convertToUnifiedDiff } from '../utils/patch.js';
import { generatePatch } from './index.js';
import { 
  BOX, 
  echoCommand, 
  askYesNo, 
  askInput,
  getReadline,
  closeReadline 
} from '../ui/terminalUI.js';

/**
 * Tool Registry - defines all available tools with their schemas
 */
export const AVAILABLE_TOOLS = [
  {
    name: "list_directory_contents",
    description: "Lists all files and subdirectories within a specified directory. If no path is given, lists contents of the current_working_directory.",
    parameters: {
      directory_path: { type: "string", description: "Directory to list (optional, defaults to current directory)" }
    }
  },
  {
    name: "read_file_content",
    description: "Reads and returns the content of a specified file. Can optionally read a specific range of lines.",
    parameters: {
      file_path: { type: "string", description: "Path to the file to read", required: true },
      start_line: { type: "number", description: "Starting line number (optional)" },
      end_line: { type: "number", description: "Ending line number (optional)" }
    }
  },
  {
    name: "run_diagnostic_command",
    description: "Executes a *safe, read-only* terminal command to gather more system or environment information (e.g., `git status`, `npm list`). DO NOT use for commands that modify files or state.",
    parameters: {
      command_string: { type: "string", description: "The command to execute", required: true }
    }
  },
  {
    name: "propose_code_patch",
    description: "Generates and proposes a code patch for a specific file. You must provide the file_path and the patch_content as structured changes. The system will ask the user for confirmation.",
    parameters: {
      file_path: { type: "string", description: "Path to the file to patch", required: true },
      patch_content: { 
        type: "object", 
        description: "Structured description of changes to make",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line_number: { type: "number" },
                action: { type: "string", enum: ["replace", "delete", "insert"] },
                old_content: { type: "string" },
                new_content: { type: "string" }
              }
            }
          }
        }
      },
      patch_description: { type: "string", description: "Human-readable description of the patch" }
    }
  },
  {
    name: "propose_fix_by_command",
    description: "Proposes a terminal command to the user that is intended to *fix* an issue. The system will ask the user for confirmation before running.",
    parameters: {
      command_to_propose: { type: "string", description: "The command to propose", required: true },
      command_description: { type: "string", description: "Description of what the command does" }
    }
  },
  {
    name: "ask_user_for_clarification",
    description: "Asks the user a specific question to get more information or clarification.",
    parameters: {
      question_for_user: { type: "string", description: "The question to ask the user", required: true }
    }
  },
  {
    name: "search_file_content",
    description: "Search for specific text patterns or keywords across files in the project.",
    parameters: {
      search_pattern: { type: "string", description: "Pattern to search for", required: true },
      file_extensions: { 
        type: "array", 
        items: { type: "string" },
        description: "File extensions to search (e.g., ['.js', '.py'])" 
      },
      max_results: { type: "number", description: "Maximum number of results to return", default: 10 }
    }
  },
  {
    name: "get_file_structure",
    description: "Get a tree view of the project structure with file sizes and types.",
    parameters: {
      max_depth: { type: "number", description: "Maximum depth to traverse", default: 3 },
      include_hidden: { type: "boolean", description: "Include hidden files", default: false }
    }
  },
  {
    name: "finish_debugging",
    description: "Concludes the current debugging session.",
    parameters: {
      conclusion_message_for_user: { type: "string", description: "Final message to the user", required: true },
      final_status: { 
        type: "string", 
        enum: ["resolved", "guidance_provided", "cannot_resolve", "aborted_by_user_request"],
        description: "Status of the debugging session"
      }
    }
  }
];

/**
 * File state utility functions
 */

/**
 * Resolves a file path using persisted file state
 */
function resolveFileWithState(requestedPath, context) {
  if (!context.file_state) return requestedPath;
  
  // 1. Check direct mapping
  if (context.file_state.file_mappings && context.file_state.file_mappings[requestedPath]) {
    console.log(chalk.green(`  ✓ Mapped ${requestedPath} → ${context.file_state.file_mappings[requestedPath]}`));
    return context.file_state.file_mappings[requestedPath];
  }
  
  // 2. Check if file exists as-is
  const testPath = resolve(context.current_working_directory || '.', requestedPath);
  if (fs.existsSync(testPath)) return requestedPath;
  
  // 3. Try primary error file
  if (context.file_state.primary_error_file) {
    console.log(chalk.yellow(`  ⚠ Using primary error file: ${context.file_state.primary_error_file}`));
    return context.file_state.primary_error_file;
  }
  
  // 4. Try first discovered file as last resort
  if (context.file_state.discovered_files && context.file_state.discovered_files.length > 0) {
    console.log(chalk.yellow(`  ⚠ Using first discovered file: ${context.file_state.discovered_files[0]}`));
    return context.file_state.discovered_files[0];
  }
  
  return requestedPath;
}

/**
 * Creates file mappings from traceback files to actual files
 */
function createFileMappings(tracebackFiles, discoveredFiles) {
  const mappings = {};
  
  // Map simplified names to actual files
  for (const [tracebackFile] of tracebackFiles.entries()) {
    const fileName = tracebackFile.split('/').pop(); // Get just the filename
    
    // Find matching discovered file
    const match = discoveredFiles.find(f => 
      f === fileName || 
      f.includes(fileName.replace(/\.[^.]*$/, '')) // Match without extension
    );
    
    if (match && fileName !== match) {
      mappings[fileName] = match;
      console.log(chalk.blue(`  📍 Created mapping: ${fileName} → ${match}`));
    }
  }
  
  return mappings;
}

/**
 * Knowledge base update functions
 */

/**
 * Updates the knowledge base with newly discovered files and directories
 */
function updateKnowledgeBaseWithNewFiles(context, directoryPath, newContents) {
  if (!context.knowledge_base) return;
  
  const relativeDirPath = relative(context.current_working_directory || '.', directoryPath);
  console.log(chalk.blue(`🔄 Updating knowledge base with discoveries from: ${relativeDirPath || '.'}`));
  
  let updatesCount = 0;
  
  // 1. Update file_structure.flat_files with new files
  if (context.knowledge_base.file_structure) {
    const existingPaths = new Set(context.knowledge_base.file_structure.flat_files.map(f => f.path));
    const newFiles = newContents.filter(item => 
      item.type === 'file' && 
      !existingPaths.has(item.path) &&
      shouldIncludeFileInKnowledgeBase(item)
    );
    
    if (newFiles.length > 0) {
      context.knowledge_base.file_structure.flat_files.push(...newFiles);
      context.knowledge_base.file_structure.metadata.relevant_files += newFiles.length;
      context.knowledge_base.file_structure.metadata.code_files += newFiles.filter(f => f.is_code_file).length;
      updatesCount += newFiles.length;
      
      console.log(chalk.green(`  ✓ Added ${newFiles.length} new files to flat_files`));
    }
  }
  
  // 2. Update file_state.discovered_files with relevant new files
  if (context.file_state) {
    const existingFiles = new Set(context.file_state.discovered_files);
    const newRelevantFiles = newContents
      .filter(item => item.type === 'file' && !existingFiles.has(item.name) && shouldIncludeFileInKnowledgeBase(item))
      .map(item => item.name);
    
    if (newRelevantFiles.length > 0) {
      context.file_state.discovered_files.push(...newRelevantFiles);
      console.log(chalk.green(`  ✓ Added ${newRelevantFiles.length} files to file_state cache`));
    }
  }
  
  // 3. Update tree_structure if we're exploring a new directory
  if (context.knowledge_base.file_structure && context.knowledge_base.file_structure.tree_structure) {
    updateTreeStructureWithDirectory(context.knowledge_base.file_structure.tree_structure, relativeDirPath, newContents);
  }
  
  // 4. Log exploration note
  if (updatesCount > 0) {
    context.knowledge_base.error_analysis_notes = context.knowledge_base.error_analysis_notes || [];
    context.knowledge_base.error_analysis_notes.push({
      type: 'directory_exploration',
      directory: relativeDirPath || 'root',
      files_discovered: newContents.filter(c => c.type === 'file').length,
      directories_discovered: newContents.filter(c => c.type === 'directory').length,
      timestamp: new Date().toISOString()
    });
    
    console.log(chalk.blue(`  📊 Total knowledge base updates: ${updatesCount}`));
  }
}

/**
 * Determines if a file should be included in the knowledge base based on our filtering criteria
 */
function shouldIncludeFileInKnowledgeBase(fileItem) {
  return fileItem.is_code_file ||                                                    // All code files
         (fileItem.name === 'package.json' && !fileItem.path.includes('node_modules/')) || // Only root package.json
         (fileItem.name === 'package-lock.json') ||                                 // Package lock files
         ['yaml', 'yml', 'env', 'toml', 'ini', 'cfg', 'conf'].includes(fileItem.extension) || // Config files
         (fileItem.extension === 'md' && fileItem.depth <= 1) ||                   // Only root-level docs
         fileItem.name.toLowerCase().includes('requirements') ||                    // Python requirements
         fileItem.name.toLowerCase().includes('dockerfile') ||                      // Docker files
         fileItem.name.toLowerCase().includes('makefile') ||                        // Build files
         (fileItem.name.startsWith('.') && fileItem.size_bytes < 5000) ||          // Small dotfiles only
         (fileItem.size_bytes < 1000 && fileItem.depth <= 1);                      // Very small root files only
}

/**
 * Validates if cached search results are still valid based on file modification times
 */
async function isSearchCacheValid(cachedSearch, context) {
  try {
    // Cache is valid for 5 minutes regardless of file changes (performance optimization)
    const cacheAgeMs = Date.now() - cachedSearch.timestamp;
    const maxCacheAgeMs = 5 * 60 * 1000; // 5 minutes
    
    if (cacheAgeMs < maxCacheAgeMs) {
      // For recent caches, do a quick validation of a few key files
      const filesToCheck = cachedSearch.searched_files_metadata.slice(0, Math.min(5, cachedSearch.searched_files_metadata.length));
      
      for (const fileMetadata of filesToCheck) {
        try {
          const { promises: fsPromises } = await import('fs');
          const { resolve } = await import('path');
          const fullPath = resolve(context.current_working_directory || '.', fileMetadata.path);
          const stats = await fsPromises.stat(fullPath);
          
          // If any checked file has changed, invalidate cache
          if (stats.mtime.getTime() !== fileMetadata.mtime) {
            console.log(chalk.yellow(`  ⚠️ Cache invalidated: ${fileMetadata.path} modified`));
            return false;
          }
        } catch (statError) {
          // If file no longer exists, invalidate cache
          console.log(chalk.yellow(`  ⚠️ Cache invalidated: ${fileMetadata.path} not accessible`));
          return false;
        }
      }
      
      return true; // Cache is valid
    }
    
    // For older caches, always invalidate to ensure freshness
    console.log(chalk.yellow(`  ⚠️ Cache expired: ${Math.round(cacheAgeMs / 1000)}s old (max: ${Math.round(maxCacheAgeMs / 1000)}s)`));
    return false;
    
  } catch (error) {
    // If validation fails, assume cache is invalid
    console.log(chalk.yellow(`  ⚠️ Cache validation failed: ${error.message}`));
    return false;
  }
}

/**
 * Generates visual tree representation from cached tree structure
 */
function generateVisualTreeFromStructure(treeStructure, maxDepth, includeHidden, currentDepth = 0, prefix = '') {
  const lines = [];
  
  if (currentDepth >= maxDepth) return lines;
  
  const entries = Object.entries(treeStructure).filter(([name, node]) => 
    includeHidden || !name.startsWith('.')
  );
  
  entries.forEach(([name, node], index) => {
    const isLast = index === entries.length - 1;
    const currentPrefix = prefix + (isLast ? '└── ' : '├── ');
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');
    
    if (node.type === 'directory') {
      lines.push(`${currentPrefix}${name}/`);
      if (node.children && currentDepth + 1 < maxDepth) {
        lines.push(...generateVisualTreeFromStructure(
          node.children, maxDepth, includeHidden, currentDepth + 1, nextPrefix
        ));
      }
    } else {
      const sizeInfo = node.size_formatted ? ` (${node.size_formatted})` : '';
      lines.push(`${currentPrefix}${name}${sizeInfo}`);
    }
  });
  
  return lines;
}

/**
 * Updates the tree structure with a new directory's contents
 */
function updateTreeStructureWithDirectory(treeStructure, relativeDirPath, contents) {
  const pathParts = relativeDirPath ? relativeDirPath.split('/').filter(Boolean) : [];
  let currentNode = treeStructure;
  
  // Navigate to the correct node in the tree
  for (const part of pathParts) {
    if (!currentNode[part]) {
      currentNode[part] = {
        type: "directory",
        path: pathParts.slice(0, pathParts.indexOf(part) + 1).join('/'),
        depth: pathParts.indexOf(part),
        children: {}
      };
    }
    currentNode = currentNode[part].children;
  }
  
  // Add new contents to this node
  for (const item of contents) {
    if (!currentNode[item.name]) {
      if (item.type === 'directory') {
        currentNode[item.name] = {
          type: "directory",
          path: item.path,
          depth: item.depth,
          children: {}
        };
      } else {
        currentNode[item.name] = {
          type: "file",
          path: item.path,
          depth: item.depth,
          size_bytes: item.size_bytes,
          size_formatted: item.size_formatted,
          extension: item.extension
        };
      }
    }
  }
}

/**
 * Tool implementation functions
 */


export async function list_directory_contents(params, context) {
  try {
    const directory_path = params.directory_path || '.';
    
    // Check if we can use cached data for the current directory
    const requestingRootDir = !params.directory_path || directory_path === '.';
    if (requestingRootDir && context.file_state && context.file_state.discovered_files) {
      console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold('ls -la')} ${chalk.gray('(using cache)')}`);
      console.log(chalk.green(`  ✓ Found ${context.file_state.discovered_files.length} cached files`));
      console.log(chalk.gray('  💡 Use a specific directory_path to explore subdirectories'));
      
      return {
        status: "success",
        directory_path: context.current_working_directory,
        contents: context.file_state.discovered_files,
        detailed_contents: context.file_state.discovered_files.map(name => ({
          name,
          type: 'file', // Cache only contains files
          isHidden: name.startsWith('.')
        })),
        source: "cached_from_file_state",
        cache_note: "Root directory cache - use directory_path to explore subdirectories"
      };
    }
    
    // Resolve directory path relative to the user's working directory, not the CLI's directory
    const resolvedPath = resolve(context.current_working_directory || '.', directory_path);
    
    // Show CLI command being executed (with -la for detailed listing)
    const displayPath = directory_path === '.' ? '' : ` ${directory_path}`;
    console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(`ls -la${displayPath}`)}`);
    
    // Show path being explored
    console.log(chalk.gray(`  → Exploring: ${resolvedPath}`));
    
    const entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
    const contents = await Promise.all(entries.map(async entry => {
      const fullPath = join(resolvedPath, entry.name);
      const relativePath = relative(context.current_working_directory || '.', fullPath);
      
      let size_bytes = 0;
      let size_formatted = "unknown";
      
      if (entry.isFile()) {
        try {
          const stats = await fsPromises.stat(fullPath);
          size_bytes = stats.size;
          size_formatted = size_bytes < 1024 ? `${size_bytes}B` : 
                          size_bytes < 1024 * 1024 ? `${Math.round(size_bytes / 1024)}KB` :
                          `${Math.round(size_bytes / (1024 * 1024))}MB`;
        } catch (statError) {
          // Keep defaults
        }
      }
      
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        isHidden: entry.name.startsWith('.'),
        path: relativePath,
        size_bytes,
        size_formatted,
        extension: entry.isFile() ? (entry.name.split('.').pop()?.toLowerCase() || null) : null,
        is_code_file: entry.isFile() && ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'cpp', 'c', 'rb', 'go', 'rs', 'php', 'swift', 'kt', 'cs'].includes(entry.name.split('.').pop()?.toLowerCase()),
        depth: relativePath.split('/').length - 1
      };
    }));
    
    // Update knowledge base with new discoveries
    updateKnowledgeBaseWithNewFiles(context, resolvedPath, contents);
    
    return {
      status: "success",
      directory_path: resolvedPath,
      contents: contents.map(c => `${c.name}${c.type === 'directory' ? '/' : ''}`),
      detailed_contents: contents,
      knowledge_base_updated: true,
      new_files_discovered: contents.filter(c => c.type === 'file').length,
      new_directories_discovered: contents.filter(c => c.type === 'directory').length
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to list directory contents: ${error.message}`
    };
  }
}

export async function read_file_content(params, context) {
  try {
    const { file_path, start_line, end_line } = params;
    
    // NEW: Use file state to resolve file path intelligently
    let resolvedFilePath = file_path;
    if (context.file_state) {
      console.log(chalk.blue('🔍 Using persisted file state for resolution'));
      resolvedFilePath = resolveFileWithState(file_path, context);
    }
    
    // Resolve file path relative to the user's working directory, not the CLI's directory
    const resolvedPath = resolve(context.current_working_directory || '.', resolvedFilePath);
    const relativePath = relative(context.current_working_directory || '.', resolvedPath);
    
    // DEBUG: Log file path resolution
    console.log(chalk.blue('🔍 DEBUG: File path resolution:'));
    console.log(chalk.gray(`  - Requested file: ${file_path}`));
    if (file_path !== resolvedFilePath) {
      console.log(chalk.gray(`  - Resolved to: ${resolvedFilePath}`));
    }
    console.log(chalk.gray(`  - Working directory: ${context.current_working_directory}`));
    console.log(chalk.gray(`  - Final path: ${resolvedPath}`));
    console.log(chalk.gray(`  - File exists: ${fs.existsSync(resolvedPath)}`));
    
    // NEW: Check if already read recently and content is cached
    if (!start_line && !end_line && context.knowledge_base.files_read[relativePath]) {
      const lastRead = context.session_history.findLast(step => 
        (step.action_taken.tool_used === "read_file_content" || step.action_taken.tool_to_use === "read_file_content") &&
        step.action_taken.parameters?.file_path === file_path
      );
      
      if (lastRead && (context.session_history.length - lastRead.step) < 3) {
        return {
          status: "success",
          file_path: relativePath,
          content: context.knowledge_base.files_read[relativePath],
          note: `Using cached content from step ${lastRead.step}`,
          cached: true,
          lines_read: [1, context.knowledge_base.files_read[relativePath].split('\n').length],
          total_lines: context.knowledge_base.files_read[relativePath].split('\n').length
        };
      }
    }
    
    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return {
        status: "error",
        message: `File not found: ${file_path}`
      };
    }
    
    if (start_line || end_line) {
      // Use the existing readFileContext function for line ranges
      const contextResult = readFileContext(resolvedPath, start_line || 1, end_line ? (end_line - (start_line || 1) + 1) : 50);
      return {
        status: "success",
        file_path: relativePath,
        content: contextResult.content,
        lines_read: [contextResult.start, contextResult.end],
        total_lines: contextResult.content.split('\n').length
      };
    } else {
      // Read entire file
      const content = await fsPromises.readFile(resolvedPath, 'utf8');
      const lines = content.split('\n');
      
      return {
        status: "success",
        file_path: relativePath,
        content: content,
        lines_read: [1, lines.length],
        total_lines: lines.length
      };
    }
  } catch (error) {
    return {
      status: "error",
      message: `Failed to read file: ${error.message}`
    };
  }
}

export async function run_diagnostic_command(params, context) {
  try {
    const { command_string } = params;
    
    // Validate command_string parameter
    if (!command_string || typeof command_string !== 'string') {
      return {
        status: "error",
        message: `Invalid command_string parameter: ${JSON.stringify(command_string)}`
      };
    }
    
    // Safety check - only allow read-only commands
    const dangerousCommands = ['rm', 'del', 'format', 'mkfs', 'dd', 'mv', 'cp', '>', '>>', 'sudo'];
    const isDangerous = dangerousCommands.some(cmd => 
      command_string.toLowerCase().includes(cmd)
    );
    
    if (isDangerous) {
      return {
        status: "error",
        message: `Command '${command_string}' appears to be potentially destructive and is not allowed`
      };
    }
    
    // Show CLI command being executed
    console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(command_string)}`);
    
    const result = runCommand(command_string);
    
    return {
      status: result.ok ? "success" : "error",
      command: command_string,
      stdout: result.output,
      stderr: result.ok ? "" : result.output,
      exit_code: result.ok ? 0 : 1
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to execute command: ${error.message}`
    };
  }
}

export async function propose_code_patch(params, context) {
  try {
    const { file_path, patch_content, patch_description } = params;
    
    // NEW: Use file state to resolve patch target intelligently
    let targetFile = file_path;
    if (context.file_state) {
      console.log(chalk.blue('🔍 Using persisted file state for patch target resolution'));
      targetFile = resolveFileWithState(file_path, context);
    }
    
    // Resolve file path relative to the user's working directory, not the CLI's directory
    const resolvedPath = resolve(context.current_working_directory || '.', targetFile);
    const relativePath = relative(context.current_working_directory || '.', resolvedPath);
    
    // DEBUG: Log patch path resolution
    console.log(chalk.blue('🔍 DEBUG: Patch file resolution:'));
    console.log(chalk.gray(`  - Requested file: ${file_path}`));
    if (file_path !== targetFile) {
      console.log(chalk.gray(`  - Resolved to: ${targetFile}`));
    }
    console.log(chalk.gray(`  - Working directory: ${context.current_working_directory}`));
    console.log(chalk.gray(`  - Final path: ${resolvedPath}`));
    console.log(chalk.gray(`  - File exists: ${fs.existsSync(resolvedPath)}`));
    
    // Enhanced error message when file still not found
    if (!fs.existsSync(resolvedPath)) {
      const availableFiles = context.file_state?.discovered_files || [];
      return {
        status: "error",
        message: `Cannot patch file: ${file_path} → ${targetFile} does not exist at ${resolvedPath}`,
        available_files: availableFiles,
        suggestion: availableFiles.length > 0 ? `Try patching: ${availableFiles.join(' or ')}` : "Run list_directory_contents first"
      };
    }
    
    // Convert structured patch to unified diff
    let unifiedDiff;
    if (typeof patch_content === 'object' && patch_content.changes) {
      try {
        unifiedDiff = convertToUnifiedDiff({
          changes: patch_content.changes.map(change => ({
            file_path: relativePath,
            line_number: change.line_number,
            old_line: change.old_content || '',
            new_line: change.action === 'delete' ? null : change.new_content
          }))
        }, context.current_working_directory);
      } catch (conversionError) {
        // Fallback: use the existing generatePatch function
        console.log(chalk.yellow('Structured patch conversion failed, using LLM fallback'));
        const fallbackResult = await generatePatch(
          `Patch request: ${patch_description}`,
          [],
          `Apply the following changes to ${file_path}: ${JSON.stringify(patch_content)}`,
          context.current_working_directory,
          'phi4:latest', // Use default model
          {},
          '',
          ''
        );
        unifiedDiff = fallbackResult.diff;
      }
    } else {
      unifiedDiff = patch_content;
    }
    
    // Display patch description to user
    if (patch_description) {
      console.log(boxen(patch_description, { ...BOX.OUTPUT, title: 'Proposed Patch' }));
    }
    
    // Show the diff and get user confirmation
    const applied = await confirmAndApply(unifiedDiff, context.current_working_directory);
    
    return {
      status: "success",
      user_confirmation: applied,
      message: applied ? "Patch applied successfully" : "Patch was rejected by user",
      patch_applied: applied
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to apply patch: ${error.message}`
    };
  }
}

export async function propose_fix_by_command(params, context) {
  try {
    const { command_to_propose, command_description } = params;
    
    // Display the proposed command
    if (command_description) {
      console.log(boxen(command_description, { ...BOX.OUTPUT, title: 'Proposed Command' }));
    }
    
    console.log(boxen(command_to_propose, { ...BOX.OUTPUT, title: 'Command to Execute' }));
    
    // Ask for user confirmation
    const confirmed = await askYesNo('Run this command?');
    
    if (!confirmed) {
      return {
        status: "success",
        user_confirmation: false,
        message: "Command was rejected by user"
      };
    }
    
    // Execute the command
    echoCommand(command_to_propose);
    const result = runCommand(command_to_propose);
    
    return {
      status: "success",
      user_confirmation: true,
      command_output: {
        stdout: result.output,
        stderr: result.ok ? "" : result.output,
        exit_code: result.ok ? 0 : 1,
        success: result.ok
      },
      message: result.ok ? "Command executed successfully" : "Command failed"
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to execute command: ${error.message}`
    };
  }
}

export async function ask_user_for_clarification(params, context) {
  try {
    const { question_for_user } = params;
    
    console.log(boxen(question_for_user, { ...BOX.PROMPT, title: 'Agent Question' }));
    
    const response = await askInput('Your response: ');
    
    return {
      status: "success",
      user_response: response.trim()
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to get user response: ${error.message}`
    };
  }
}

export async function search_file_content(params, context) {
  try {
    const { search_pattern, file_extensions = ['.js', '.py', '.ts', '.jsx', '.tsx', '.json'], max_results = 10 } = params;
    
    // Generate cache key
    const cacheKey = `${search_pattern}:${file_extensions.sort().join(',')}:${max_results}`;
    
    // Check if we can use cached search results
    const cachedSearch = context.knowledge_base?.search_results?.[cacheKey];
    if (cachedSearch && await isSearchCacheValid(cachedSearch, context)) {
      // Show CLI command with cache indicator
      const extensionPattern = file_extensions.length > 1 ? `{${file_extensions.join(',')}}` : file_extensions[0] || '*';
      console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(`grep -r "${search_pattern}" --include="*${extensionPattern}"`)} ${chalk.gray('(using cache)')}`);
      console.log(chalk.green(`  ✓ Found ${cachedSearch.results.length} cached results from ${cachedSearch.files_searched} files`));
      console.log(chalk.gray(`  💡 Cache created: ${new Date(cachedSearch.timestamp).toLocaleTimeString()}`));
      
      return {
        status: "success",
        search_pattern: cachedSearch.search_pattern,
        results_count: cachedSearch.results.length,
        results: cachedSearch.results.slice(0, max_results),
        source: "cached_search_results",
        cache_info: {
          cached_at: cachedSearch.timestamp,
          files_searched: cachedSearch.files_searched,
          original_max_results: cachedSearch.max_results
        }
      };
    }
    
    // Show CLI command for fresh search
    const extensionPattern = file_extensions.length > 1 ? `{${file_extensions.join(',')}}` : file_extensions[0] || '*';
    console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(`grep -r "${search_pattern}" --include="*${extensionPattern}"`)}`);
    console.log(chalk.gray(`  → Performing fresh content search`));
    
    // Use a simple recursive search
    const results = [];
    const searchedFiles = [];
    const currentTime = Date.now();
    
    async function searchInDirectory(dir, depth = 0) {
      if (depth > 3 || results.length >= max_results) return;
      
      try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (results.length >= max_results) break;
          
          const fullPath = join(dir, entry.name);
          
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await searchInDirectory(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const hasValidExtension = file_extensions.some(ext => entry.name.endsWith(ext));
            if (hasValidExtension) {
              const relativePath = relative(context.current_working_directory || '.', fullPath);
              try {
                // Track file metadata for cache invalidation
                const stats = await fsPromises.stat(fullPath);
                searchedFiles.push({
                  path: relativePath,
                  mtime: stats.mtime.getTime(),
                  size: stats.size
                });
                
                const content = await fsPromises.readFile(fullPath, 'utf8');
                const lines = content.split('\n');
                
                lines.forEach((line, index) => {
                  if (results.length >= max_results) return;
                  if (line.toLowerCase().includes(search_pattern.toLowerCase())) {
                    results.push({
                      file: relativePath,
                      line_number: index + 1,
                      line_content: line.trim(),
                      context: lines.slice(Math.max(0, index - 1), index + 2)
                    });
                  }
                });
              } catch (readError) {
                // Skip files that can't be read
              }
            }
          }
        }
      } catch (dirError) {
        // Skip directories that can't be read
      }
    }
    
    await searchInDirectory(context.current_working_directory || '.');
    
    // Cache the search results for future use
    const searchResult = {
      search_pattern,
      file_extensions,
      max_results,
      results: results.slice(0, max_results),
      files_searched: searchedFiles.length,
      searched_files_metadata: searchedFiles,
      timestamp: currentTime
    };
    
    // Update knowledge base with search cache
    if (context.knowledge_base) {
      context.knowledge_base.search_results = context.knowledge_base.search_results || {};
      context.knowledge_base.search_results[cacheKey] = searchResult;
      
      // Update file metadata for cache invalidation
      context.knowledge_base.file_metadata = context.knowledge_base.file_metadata || {};
      searchedFiles.forEach(file => {
        context.knowledge_base.file_metadata[file.path] = {
          mtime: file.mtime,
          size: file.size,
          last_checked: currentTime
        };
      });
      
      console.log(chalk.blue(`🔄 Cached search results (${results.length} matches from ${searchedFiles.length} files)`));
    }
    
    return {
      status: "success",
      search_pattern,
      results_count: results.length,
      results: results.slice(0, max_results),
      source: "fresh_content_search",
      search_info: {
        files_searched: searchedFiles.length,
        cache_updated: true,
        search_duration_ms: Date.now() - currentTime
      }
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to search files: ${error.message}`
    };
  }
}

export async function get_file_structure(params, context) {
  try {
    const { max_depth = 3, include_hidden = false } = params;
    
    // Check if we can use cached file structure
    const cachedStructure = context.knowledge_base?.file_structure;
    if (cachedStructure && 
        cachedStructure.max_depth >= max_depth && 
        (!include_hidden || cachedStructure.included_hidden)) {
      
      console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(`tree -L ${max_depth}${include_hidden ? ' -a' : ''}`)} ${chalk.gray('(using cache)')}`);
      
      // Generate visual tree from cached tree_structure
      const visualTree = generateVisualTreeFromStructure(cachedStructure.tree_structure, max_depth, include_hidden);
      
      console.log(chalk.green(`  ✓ Using cached structure (${cachedStructure.metadata.total_files} files)`));
      console.log(chalk.gray('  💡 Structure was pre-built during initialization'));
      
      return {
        status: "success",
        structure: visualTree,
        structure_text: visualTree.join('\n'),
        source: "cached_from_knowledge_base",
        cache_info: {
          cached_max_depth: cachedStructure.max_depth,
          total_files: cachedStructure.metadata.total_files,
          relevant_files: cachedStructure.metadata.relevant_files
        }
      };
    }
    
    // Show CLI command being executed (fresh scan)
    const hiddenFlag = include_hidden ? 'a' : '';
    console.log(`  ${chalk.blueBright.bold('$')} ${chalk.blueBright.bold(`tree -L ${max_depth}${hiddenFlag ? ' -a' : ''}`)}`);
    console.log(chalk.gray(`  → Performing fresh filesystem scan`));
    
    const structure = [];
    
    async function buildStructure(dir, depth = 0, prefix = '') {
      if (depth >= max_depth) return;
      
      try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        const filteredEntries = entries.filter(entry => 
          include_hidden || !entry.name.startsWith('.')
        );
        
        for (let i = 0; i < filteredEntries.length; i++) {
          const entry = filteredEntries[i];
          const isLast = i === filteredEntries.length - 1;
          const currentPrefix = prefix + (isLast ? '└── ' : '├── ');
          const nextPrefix = prefix + (isLast ? '    ' : '│   ');
          
          const fullPath = join(dir, entry.name);
          
          if (entry.isDirectory()) {
            structure.push(`${currentPrefix}${entry.name}/`);
            await buildStructure(fullPath, depth + 1, nextPrefix);
          } else {
            try {
              const stats = await fsPromises.stat(fullPath);
              const size = stats.size < 1024 ? `${stats.size}B` : 
                          stats.size < 1024 * 1024 ? `${Math.round(stats.size / 1024)}KB` :
                          `${Math.round(stats.size / (1024 * 1024))}MB`;
              structure.push(`${currentPrefix}${entry.name} (${size})`);
            } catch (statError) {
              structure.push(`${currentPrefix}${entry.name}`);
            }
          }
        }
      } catch (dirError) {
        // Skip directories that can't be read
      }
    }
    
    await buildStructure(context.current_working_directory || '.');
    
    // Update knowledge base if this scan was deeper or more comprehensive than cached version
    if (context.knowledge_base && 
        (!cachedStructure || max_depth > cachedStructure.max_depth || 
         (include_hidden && !cachedStructure.included_hidden))) {
      
      console.log(chalk.blue(`🔄 Updating knowledge base with enhanced file structure (depth: ${max_depth}, hidden: ${include_hidden})`));
      
      // Note: For now, we'll just log the update. In a full implementation, we'd 
      // rebuild the tree_structure and flat_files from the fresh scan
      context.knowledge_base.error_analysis_notes = context.knowledge_base.error_analysis_notes || [];
      context.knowledge_base.error_analysis_notes.push({
        type: 'file_structure_update',
        scan_depth: max_depth,
        include_hidden: include_hidden,
        lines_generated: structure.length,
        timestamp: new Date().toISOString()
      });
    }
    
    return {
      status: "success",
      structure: structure,
      structure_text: structure.join('\n'),
      source: "fresh_filesystem_scan",
      scan_info: {
        max_depth: max_depth,
        include_hidden: include_hidden,
        total_items: structure.length
      }
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to get file structure: ${error.message}`
    };
  }
}

export async function finish_debugging(params, context) {
  const { conclusion_message_for_user, final_status } = params;
  
  console.log(boxen(conclusion_message_for_user, { 
    ...BOX.OUTPUT, 
    title: `Debugging Complete - ${final_status.replace('_', ' ').toUpperCase()}` 
  }));
  
  return {
    status: "finished",
    final_status,
    message: conclusion_message_for_user
  };
}

/**
 * Tool dispatcher - executes the appropriate tool function
 */
export async function executeAgentTool(toolName, parameters, context) {
  // Import deduplication functions
  const { shouldSkipAction, createActionSignature } = await import('./agent_prompt.js');
  
  // NEW: Check for recent duplicate actions
  const skipCheck = shouldSkipAction(toolName, parameters, context);
  if (skipCheck.should_skip) {
    return {
      status: "skipped",
      message: `Action skipped - ${skipCheck.reason}`,
      duplicate_step: skipCheck.duplicate_step,
      previous_result: context.recent_actions.find(a => a.step === skipCheck.duplicate_step)?.result
    };
  }
  
  const toolFunctions = {
    list_directory_contents,
    read_file_content,
    run_diagnostic_command,
    propose_code_patch,
    propose_fix_by_command,
    ask_user_for_clarification,
    search_file_content,
    get_file_structure,
    finish_debugging
  };
  
  const toolFunction = toolFunctions[toolName];
  if (!toolFunction) {
    return {
      status: "error",
      message: `Unknown tool: ${toolName}`
    };
  }
  
  try {
    return await toolFunction(parameters, context);
  } catch (error) {
    return {
      status: "error",
      message: `Tool execution failed: ${error.message}`
    };
  }
}

/**
 * Helper functions
 */

function extractKeyErrorMessages(stderr) {
  const lines = stderr.split('\n');
  const errorMessages = [];
  
  for (const line of lines) {
    if (line.includes('Error:') || 
        line.includes('Exception:') || 
        line.includes('error:') ||
        line.includes('ERROR:') ||
        line.includes('FAILED:')) {
      errorMessages.push(line.trim());
    }
  }
  
  return errorMessages;
}

function suggestFocusAreas(stderr, filesWithErrors) {
  const suggestions = [];
  
  if (filesWithErrors.size > 0) {
    const files = Array.from(filesWithErrors.keys());
    suggestions.push(`FOCUS: Read file ${files.map(f => f.split('/').pop()).join(', ')}`);
  }
  
  if (stderr.includes('ModuleNotFoundError') || stderr.includes('ImportError')) {
    suggestions.push('ACTION: Check if conda environment needs activation or install missing package');
    suggestions.push('NEXT: Use run_diagnostic_command to check "conda env list" or propose pip install');
  }
  
  if (stderr.includes('KeyError') && stderr.includes('Column not found')) {
    // Extract the missing column name
    const columnMatch = stderr.match(/KeyError.*['"](.+?)['"] /);
    const missingColumn = columnMatch ? columnMatch[1] : 'unknown';
    
    suggestions.push(`ACTION: Read the Python file to see line with error (column '${missingColumn}')`);
    suggestions.push('ACTION: Read the CSV/data file to see actual column names');
    suggestions.push(`NEXT: Propose code patch to fix column name '${missingColumn}'`);
  }
  
  if (stderr.includes('FileNotFoundError') || stderr.includes('No such file')) {
    suggestions.push('ACTION: List current directory contents to find correct file');
  }
  
  if (stderr.includes('PermissionError') || stderr.includes('Permission denied')) {
    suggestions.push('ACTION: Check file permissions or propose chmod command');
  }
  
  if (stderr.includes('SyntaxError')) {
    suggestions.push('ACTION: Read the mentioned file and propose syntax fix');
  }
  
  return suggestions;
}

/**
 * Provides immediate next action guidance based on error type
 */
function getImmediateNextAction(stderr, existingFiles, workingDir) {
  if (stderr.includes('KeyError') && stderr.includes('Column not found')) {
    const pythonFile = existingFiles.find(f => f.endsWith('.py'));
    if (pythonFile) {
      return `Read file: ${pythonFile} to see the problematic line`;
    } else {
      return "List directory contents to find the Python file with the error";
    }
  }
  
  if (stderr.includes('ModuleNotFoundError')) {
    return "Check conda environment or install missing package";
  }
  
  if (stderr.includes('FileNotFoundError')) {
    return "List directory contents to find correct file path";
  }
  
  if (existingFiles.length > 0) {
    return `Read file: ${existingFiles[0]} to understand the issue`;
  }
  
  return "List directory contents to find relevant files";
}