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
    name: "initial_error_analyzer",
    description: "Parses and analyzes the initial command's error output (stderr), traceback, and stdout. Identifies key error messages, relevant file paths, and line numbers. This should typically be the first diagnostic step if an error occurred.",
    parameters: {
      command_details: {
        type: "object",
        properties: {
          command_string: { type: "string" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          exit_code: { type: "number" }
        },
        required: ["command_string", "stderr", "exit_code"]
      }
    }
  },
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
 * Tool implementation functions
 */

export async function initial_error_analyzer(params, context) {
  try {
    // DEBUG: Log what parameters are being passed
    console.log(chalk.blue('🔍 DEBUG: initial_error_analyzer called with:'));
    console.log(chalk.gray('  - params:', JSON.stringify(params, null, 2)));
    
    const { command_details } = params;
    if (!command_details) {
      return {
        status: "error",
        message: "Missing command_details parameter"
      };
    }
    
    const { command_string, stdout, stderr, exit_code } = command_details;
    
    // Ensure stdout and stderr are strings to prevent undefined errors
    const safeStdout = stdout || '';
    const safeStderr = stderr || '';
    const safeCommand = command_string || 'unknown';
    const safeExitCode = exit_code !== undefined ? exit_code : 1;
    
    // NEW: Check if this is error evolution, not initial analysis
    const isEvolution = context.session_history.length > 1;
    const isFirstStep = context.session_history.length === 0;
    
    if (isEvolution && !isFirstStep) {
      // Focus on error progression, not full re-analysis
      const analysis = await analyzeErrorEvolution(command_details, context);
      return {
        status: "success",
        analysis_type: "error_evolution",
        ...analysis
      };
    }
    
    // DEBUG: Log raw command output being processed
    console.log(chalk.blue('🔍 DEBUG: Command details:'));
    console.log(chalk.gray(`  - Command: ${safeCommand}`));
    console.log(chalk.gray(`  - Exit code: ${safeExitCode}`));
    console.log(chalk.gray(`  - Stdout length: ${safeStdout.length}`));
    console.log(chalk.gray(`  - Stderr length: ${safeStderr.length}`));
    console.log(chalk.gray('--- START STDERR ---'));
    console.log(safeStderr);
    console.log(chalk.gray('--- END STDERR ---'));
    console.log(chalk.gray('--- START STDOUT ---'));
    console.log(safeStdout);
    console.log(chalk.gray('--- END STDOUT ---'));
    
    // Use existing traceback utilities for initial analysis
    // Check both stderr and stdout for traceback information
    const combinedOutput = safeStderr + '\n' + safeStdout;
    const filesWithErrors = extractFilesFromTraceback(combinedOutput);
    const errorLines = getErrorLines(combinedOutput);
    const errorContext = buildErrorContext(combinedOutput, 5);
    
    // DEBUG: Log detected files to console for visibility
    console.log(chalk.blue('🔍 DEBUG: Files detected from traceback:'));
    for (const [file, line] of filesWithErrors.entries()) {
      console.log(chalk.gray(`  - ${file} (line ${line})`));
    }
    // Filter files to only include those that exist and are accessible
    const workingDir = context.current_working_directory || '.';
    const existingFiles = [];
    for (const [fullPath, line] of filesWithErrors.entries()) {
      const fileName = fullPath.split('/').pop();
      const resolvedPath = resolve(workingDir, fileName);
      if (fs.existsSync(resolvedPath)) {
        existingFiles.push(fileName);
        console.log(chalk.green(`  ✓ Found: ${fileName} -> ${resolvedPath}`));
      } else {
        console.log(chalk.yellow(`  ✗ Missing: ${fileName} (from ${fullPath})`));
      }
    }
    
    console.log(chalk.blue(`🔍 DEBUG: Files to read: ${existingFiles.join(', ')}`));
    console.log(chalk.blue(`🔍 DEBUG: Working directory: ${context.current_working_directory}`));
    
    // Create file mappings from traceback to discovered files
    const fileMappings = createFileMappings(filesWithErrors, existingFiles);
    
    // If no files were found in traceback, do directory discovery
    if (existingFiles.length === 0) {
      console.log(chalk.yellow('🔍 No files found in traceback - performing directory discovery...'));
      try {
        const entries = await fsPromises.readdir(workingDir, { withFileTypes: true });
        const codeFiles = entries
          .filter(entry => entry.isFile())
          .map(entry => entry.name)
          .filter(name => {
            const ext = name.split('.').pop()?.toLowerCase();
            return ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'cpp', 'c', 'rb', 'go', 'rs'].includes(ext);
          });
        
        console.log(chalk.green(`🔍 Found code files in directory: ${codeFiles.join(', ')}`));
        
        // Add discovered files to existingFiles for analysis
        existingFiles.push(...codeFiles);
      } catch (dirError) {
        console.log(chalk.red(`🔍 Failed to list directory: ${dirError.message}`));
      }
    }
    
    // Analyze the error output
    const analysis = {
      command_executed: safeCommand,
      exit_code: safeExitCode,
      error_type: safeExitCode !== 0 ? 'execution_error' : 'warning',
      files_mentioned: Array.from(filesWithErrors.keys()),
      files_to_read: existingFiles, // Only files that actually exist
      error_lines: errorLines,
      key_error_messages: extractKeyErrorMessages(combinedOutput),
      traceback_summary: combinedOutput.split('\n').filter(line => 
        line.includes('Error:') || 
        line.includes('Exception:') || 
        line.includes('Traceback')
      ),
      suggested_focus_areas: suggestFocusAreas(combinedOutput, filesWithErrors),
      immediate_next_action: getImmediateNextAction(combinedOutput, existingFiles, workingDir)
    };
    
    return {
      status: "success",
      analysis_type: "initial_analysis",
      analysis,
      files_with_errors: Array.from(filesWithErrors.keys()),
      error_context: errorContext,
      // NEW: Add file state for persistence
      file_state: {
        discovered_files: existingFiles,
        primary_error_file: existingFiles.find(f => f.endsWith('.py')) || existingFiles[0],
        file_mappings: fileMappings,
        working_directory: context.current_working_directory
      }
    };
  } catch (error) {
    return {
      status: "error",
      message: `Failed to analyze error: ${error.message}`
    };
  }
}

/**
 * Analyzes error evolution instead of doing full re-analysis
 */
async function analyzeErrorEvolution(commandDetails, context) {
  const { stderr, stdout } = commandDetails;
  const safeStderr = stderr || '';
  const safeStdout = stdout || '';
  const previousError = context.solved_issues.length > 0 ? 
    context.solved_issues[context.solved_issues.length - 1] : null;
  
  // Import error parsing function
  const { parseErrorFromOutput } = await import('./agent_prompt.js');
  const currentError = parseErrorFromOutput(safeStderr);
  
  const progressAssessment = previousError ? 
    `✓ Previous error resolved: ${previousError.type}\n⚠ New issue detected: ${currentError?.type || 'Unknown'}` :
    `Continuing analysis of: ${currentError?.type || 'Unknown error'}`;
  
  return {
    previous_error_resolved: !!previousError,
    new_error_detected: currentError,
    progress_assessment: progressAssessment,
    recommended_focus: currentError?.type || "verification",
    stdout_preview: safeStdout ? safeStdout.substring(0, 500) + (safeStdout.length > 500 ? '...' : '') : '',
    error_evolution_summary: `Step-by-step progress: ${context.solved_issues.length} issues resolved, ${currentError ? '1 active issue' : 'no current issues'}`
  };
}

export async function list_directory_contents(params, context) {
  try {
    const directory_path = params.directory_path || '.';
    
    // NEW: Use cached file state if available for current directory
    if (!params.directory_path && context.file_state && context.file_state.discovered_files) {
      console.log(chalk.blue('🔍 Using cached file discovery instead of re-listing directory'));
      console.log(chalk.green(`  ✓ Found ${context.file_state.discovered_files.length} cached files: ${context.file_state.discovered_files.join(', ')}`));
      console.log(chalk.gray('  ⚠ Note: Cache only includes root-level code files, not subdirectories'));
      
      return {
        status: "success",
        directory_path: context.current_working_directory,
        contents: context.file_state.discovered_files,
        detailed_contents: context.file_state.discovered_files.map(name => ({
          name,
          type: 'file',
          isHidden: name.startsWith('.')
        })),
        source: "cached_from_file_state",
        limitation: "root_level_only"
      };
    }
    
    // Resolve directory path relative to the user's working directory, not the CLI's directory
    const resolvedPath = resolve(context.current_working_directory || '.', directory_path);
    
    // DEBUG: Log directory path resolution
    console.log(chalk.blue('🔍 DEBUG: Directory listing:'));
    console.log(chalk.gray(`  - Requested directory: ${directory_path}`));
    console.log(chalk.gray(`  - Working directory: ${context.current_working_directory}`));
    console.log(chalk.gray(`  - Resolved path: ${resolvedPath}`));
    console.log(chalk.gray(`  - Directory exists: ${fs.existsSync(resolvedPath)}`));
    
    const entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
    const contents = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      isHidden: entry.name.startsWith('.')
    }));
    
    return {
      status: "success",
      directory_path: resolvedPath,
      contents: contents.map(c => `${c.name}${c.type === 'directory' ? '/' : ''}`),
      detailed_contents: contents
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
    
    // Use a simple recursive search
    const results = [];
    
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
              try {
                const content = await fsPromises.readFile(fullPath, 'utf8');
                const lines = content.split('\n');
                
                lines.forEach((line, index) => {
                  if (results.length >= max_results) return;
                  if (line.toLowerCase().includes(search_pattern.toLowerCase())) {
                    results.push({
                      file: relative(context.current_working_directory || '.', fullPath),
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
    
    return {
      status: "success",
      search_pattern,
      results_count: results.length,
      results: results.slice(0, max_results)
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
    
    return {
      status: "success",
      structure: structure,
      structure_text: structure.join('\n')
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
    initial_error_analyzer,
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