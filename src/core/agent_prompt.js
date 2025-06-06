/**
 * Agent Prompt Builder and Context Management
 * 
 * Handles the construction of prompts for the agentic debugging assistant
 * and manages the agent context throughout the debugging session.
 */

import { AVAILABLE_TOOLS } from './agent_tools.js';

/**
 * System prompt for the agentic debugging assistant
 */
const SYSTEM_PROMPT = `You are an expert Agentic Debugging Assistant. Your PRIMARY GOAL is to produce WORKING CODE efficiently through thoughtful analysis and minimal tool usage.

CORE PRINCIPLES:
- THOROUGH BUT EFFICIENT: Analyze deeply but act only when necessary
- WORKING CODE IS THE SUCCESS METRIC: Every patch must result in executable code
- MINIMIZE TOOL CALLS: Only use tools when you genuinely need more information to make a correct fix
- QUALITY OVER SPEED: A correct fix with 3-4 thoughtful steps beats a rushed wrong fix
- Always respond with valid JSON matching the required schema
- The user must confirm destructive actions (handled by propose_* tools)

CRITICAL SUCCESS PRIORITIES:
1. IMMEDIATE ANALYSIS: The system has already analyzed the error and populated directory info
2. THOROUGH ANALYSIS: Understand the error completely before proposing solutions
3. MINIMAL TOOL USAGE: Only call tools when you need additional information to make the right fix
4. CORRECT FIXES: Every patch must result in code that executes successfully
5. AVOID RECKLESS SUGGESTIONS: Never guess at fixes without sufficient information

DECISION-MAKING STRATEGY (BALANCED APPROACH):
1. STEP 1: Review the pre-populated knowledge base for error context and available files
2. ANALYZE THOROUGHLY: Think through the problem using the provided error context
3. CALL TOOLS ONLY WHEN NEEDED: 
   - Read files only if you need to see the actual code to understand the fix
   - Use diagnostic commands only if you need environment/system information
   - List directories only if you need more detailed structure info
4. PROPOSE FIXES: Once you have sufficient information, propose the correct solution
5. VERIFY LOGIC: Before proposing, mentally verify your fix will work

WHEN TO USE TOOLS vs WHEN TO ACT:
- USE TOOLS when:
  * Error message is ambiguous and you need to see the actual code
  * You need to understand the project structure or file contents
  * You need environment information (package versions, system state)
  * You're unsure about the exact syntax or context needed for the fix
- ACT DIRECTLY when:
  * Error message clearly shows the exact problem and solution
  * You have sufficient context from previous analysis to make the correct fix
  * The fix is obvious (clear typos, missing imports with known module names)

WORKING CODE REQUIREMENTS:
- Every proposed patch MUST result in executable code
- Think through your fix logic: Will this change actually resolve the error?
- Ensure you understand the context before making changes
- If uncertain about syntax or context, read the relevant files first
- Focus on the immediate error, not code quality improvements

QUALITY ASSURANCE RULES:
- Never guess at variable names, function names, or file paths
- If you're not 100% certain about a fix, gather more information first
- Avoid making assumptions about code structure without seeing it
- Always verify that your proposed changes match the actual codebase
- Think: "Do I have enough information to guarantee this fix will work?"

CONTEXT AWARENESS:
- solved_issues: Contains errors you've already fixed - don't address these again
- current_blocking_error: The ONLY error you should focus on right now
- recent_actions: Your last few actions - avoid repeating identical ones
- knowledge_base: Information from previous file reads and analysis

You must respond ONLY with JSON matching this schema:
{
  "thought": "Detailed reasoning for chosen action and why this tool is necessary",
  "tool_to_use": "tool_name_from_available_tools", 
  "tool_parameters": { /* tool-specific parameters */ }
}

TOOL PARAMETER EXAMPLES:
- run_diagnostic_command: {"command_string": "pip list"}
- read_file_content: {"file_path": "main.py"}
- list_directory_contents: {"directory_path": "."}

CRITICAL: Always provide the required parameters for each tool!`;

/**
 * Helper function to get file structure data in LLM-friendly format
 */
async function getFileStructureData(currentDirectory, maxDepth = 3, includeHidden = false) {
  const { promises: fsPromises } = await import('fs');
  const { join, relative } = await import('path');
  
  const treeStructure = {};
  const flatFiles = [];
  
  async function buildStructure(dir, depth = 0, currentNode = treeStructure) {
    if (depth >= maxDepth) return;
    
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      const filteredEntries = entries.filter(entry => 
        includeHidden || !entry.name.startsWith('.')
      );
      
      for (let i = 0; i < filteredEntries.length; i++) {
        const entry = filteredEntries[i];
        
        const fullPath = join(dir, entry.name);
        const relativePath = relative(currentDirectory, fullPath);
        
        if (entry.isDirectory()) {
          // Add to tree structure
          currentNode[entry.name] = {
            type: "directory",
            path: relativePath,
            depth: depth,
            children: {}
          };
          
          // Recurse into directory
          await buildStructure(fullPath, depth + 1, currentNode[entry.name].children);
        } else {
          try {
            const stats = await fsPromises.stat(fullPath);
            const sizeBytes = stats.size;
            const sizeFormatted = sizeBytes < 1024 ? `${sizeBytes}B` : 
                                sizeBytes < 1024 * 1024 ? `${Math.round(sizeBytes / 1024)}KB` :
                                `${Math.round(sizeBytes / (1024 * 1024))}MB`;
            
            // Add to tree structure
            currentNode[entry.name] = {
              type: "file",
              path: relativePath,
              depth: depth,
              size_bytes: sizeBytes,
              size_formatted: sizeFormatted,
              extension: entry.name.split('.').pop()?.toLowerCase() || null
            };
            
            // Add to flat files list
            flatFiles.push({
              name: entry.name,
              path: relativePath,
              type: "file",
              depth: depth,
              size_bytes: sizeBytes,
              size_formatted: sizeFormatted,
              extension: entry.name.split('.').pop()?.toLowerCase() || null,
              is_code_file: ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'cpp', 'c', 'rb', 'go', 'rs', 'php', 'swift', 'kt', 'cs'].includes(entry.name.split('.').pop()?.toLowerCase())
            });
          } catch (statError) {
            currentNode[entry.name] = {
              type: "file",
              path: relativePath,
              depth: depth,
              size_bytes: 0,
              size_formatted: "unknown",
              extension: entry.name.split('.').pop()?.toLowerCase() || null
            };
          }
        }
      }
    } catch (dirError) {
      // Skip directories that can't be read
    }
  }
  
  await buildStructure(currentDirectory);
  
  // Filter flat_files to only include debugging-relevant files (aggressive filtering)
  const relevantFiles = flatFiles.filter(f => 
    f.is_code_file ||                                                    // All code files
    (f.name === 'package.json' && !f.path.includes('node_modules/')) || // Only root package.json
    (f.name === 'package-lock.json') ||                                 // Package lock files
    ['yaml', 'yml', 'env', 'toml', 'ini', 'cfg', 'conf'].includes(f.extension) || // Config files (not json - too many)
    (f.extension === 'md' && f.depth <= 1) ||                           // Only root-level docs
    f.name.toLowerCase().includes('requirements') ||                    // Python requirements
    f.name.toLowerCase().includes('dockerfile') ||                      // Docker files
    f.name.toLowerCase().includes('makefile') ||                        // Build files
    (f.name.startsWith('.') && f.size_bytes < 5000) ||                 // Small dotfiles only
    (f.size_bytes < 1000 && f.depth <= 1)                              // Very small root files only
  );
  
  return {
    status: "success",
    tree_structure: treeStructure,
    flat_files: relevantFiles,
    metadata: {
      total_files: flatFiles.length,
      relevant_files: relevantFiles.length,
      filtered_out: flatFiles.length - relevantFiles.length,
      code_files: relevantFiles.filter(f => f.is_code_file).length,
      relevant_extensions: [...new Set(relevantFiles.map(f => f.extension).filter(Boolean))].slice(0, 8),
      project_root: currentDirectory
    }
  };
}

function countDirectories(node) {
  let count = 0;
  for (const [key, value] of Object.entries(node)) {
    if (value.type === 'directory') {
      count += 1 + countDirectories(value.children);
    }
  }
  return count;
}

/**
 * Pre-populates knowledge base with directory information and error analysis
 */
async function initializeKnowledgeBase(commandDetails, currentDirectory) {
  const knowledgeBase = {
    files_read: {},
    error_analysis_notes: [],
    file_structure: null,
    error_context: null,
    search_results: {},         // Cache for search_file_content results
    file_metadata: {}           // File modification times for cache invalidation
  };

  try {
    // Import necessary utilities
    const { promises: fsPromises } = await import('fs');
    const { resolve } = await import('path');
    const { 
      buildErrorContext, 
      extractFilesFromTraceback, 
      getErrorLines 
    } = await import('../utils/traceback.js');
    const chalk = await import('chalk');

    // NOTE: Removed redundant directory_listing and discovered_files
    // All file information is now consolidated in file_structure

    // 1. Analyze command error output if present
    if (commandDetails && (commandDetails.stderr || commandDetails.stdout)) {
      console.log('🔍 Pre-populating cache: Analyzing error output...');
      const combinedOutput = (commandDetails.stderr || '') + '\n' + (commandDetails.stdout || '');
      
      // Extract error context
      const errorContext = buildErrorContext(combinedOutput, 5);
      if (errorContext) {
        knowledgeBase.error_context = errorContext;
        console.log('  ✓ Error context extracted and cached');
      }

      // Extract files mentioned in traceback
      const filesWithErrors = extractFilesFromTraceback(combinedOutput);
      if (filesWithErrors.size > 0) {
        const errorFiles = Array.from(filesWithErrors.keys());
        knowledgeBase.error_analysis_notes.push({
          type: 'traceback_analysis',
          files_mentioned: errorFiles,
          timestamp: new Date().toISOString()
        });
        console.log(`  ✓ Found ${errorFiles.length} files in error traceback: ${errorFiles.join(', ')}`);
      }

      // Parse current blocking error
      const currentError = parseErrorFromOutput(combinedOutput);
      if (currentError) {
        knowledgeBase.error_analysis_notes.push({
          type: 'initial_error_parse',
          error: currentError,
          timestamp: new Date().toISOString()
        });
        console.log(`  ✓ Parsed error: ${currentError.type} - ${currentError.message}`);
      }
    }

    // 2. Get complete file structure (includes ls + pwd + tree functionality)
    console.log('🔍 Pre-populating cache: Building project structure...');
    console.log(`  ${chalk.default.blueBright.bold('$')} ${chalk.default.blueBright.bold('tree -L 3')}`);
    try {
      const fileStructure = await getFileStructureData(currentDirectory, 3, false);
      if (fileStructure.status === 'success') {
        knowledgeBase.file_structure = {
          tree_structure: fileStructure.tree_structure,
          flat_files: fileStructure.flat_files,
          metadata: fileStructure.metadata,
          max_depth: 3,
          included_hidden: false, // Initial scan excludes hidden files
          cached_at: new Date().toISOString()
        };
        console.log(`  ✓ Project structure mapped (${fileStructure.metadata.total_files} files, ${fileStructure.metadata.relevant_files} relevant)`);
        console.log(`  ✓ Filtered ${fileStructure.metadata.filtered_out} non-essential files (kept ${fileStructure.metadata.code_files} code + ${fileStructure.metadata.relevant_files - fileStructure.metadata.code_files} config/docs)`);
      }
    } catch (structureError) {
      console.log(`  ✗ Failed to build project structure: ${structureError.message}`);
    }

    console.log('✅ Knowledge base pre-population complete');
    
    // Create file_state from file_structure data for intelligent tool behavior
    const fileState = {
      discovered_files: knowledgeBase.file_structure ? 
        knowledgeBase.file_structure.flat_files.map(f => f.name) : [],
      primary_error_file: null,
      file_mappings: {}
    };
    
    // If we have error analysis, set primary error file and create mappings
    const errorFiles = knowledgeBase.error_analysis_notes
      .filter(note => note.type === 'traceback_analysis')
      .flatMap(note => note.files_mentioned || []);
    
    if (errorFiles.length > 0 && knowledgeBase.file_structure) {
      const discoveredFiles = knowledgeBase.file_structure.flat_files.map(f => f.name);
      
      // Find primary error file (first match)
      fileState.primary_error_file = discoveredFiles.find(f => 
        errorFiles.some(ef => f.includes(ef.split('/').pop()) || ef.includes(f))
      ) || null;
      
      // Create file mappings for intelligent resolution
      for (const errorFile of errorFiles) {
        const fileName = errorFile.split('/').pop();
        const match = discoveredFiles.find(f => 
          f === fileName || f.includes(fileName.replace(/\.[^.]*$/, ''))
        );
        if (match && fileName !== match) {
          fileState.file_mappings[fileName] = match;
        }
      }
      
      if (fileState.primary_error_file) {
        console.log(`  ✓ Set primary error file: ${fileState.primary_error_file}`);
      }
      if (Object.keys(fileState.file_mappings).length > 0) {
        console.log(`  ✓ Created ${Object.keys(fileState.file_mappings).length} file mappings`);
      }
    }
    
    knowledgeBase.file_state = fileState;
    return knowledgeBase;

  } catch (error) {
    console.log(`⚠️ Error during knowledge base initialization: ${error.message}`);
    return {
      files_read: {},
      error_analysis_notes: [{
        type: 'initialization_error',
        error: error.message,
        timestamp: new Date().toISOString()
      }]
    };
  }
}

/**
 * Creates initial agent context from user request and command details
 * Automatically populates directory information and error analysis
 */
export async function createInitialAgentContext(userRequest, commandDetails, currentDirectory) {
  // Pre-populate knowledge base with directory information
  const knowledgeBase = await initializeKnowledgeBase(commandDetails, currentDirectory);
  
  return {
    initial_user_request: userRequest || "Debug the error from the last command",
    initial_command_run: commandDetails || {
      command_string: "unknown",  // Fixed: was 'command', should be 'command_string'
      stdout: "",
      stderr: "No error details provided",
      exit_code: 1
    },
    current_working_directory: currentDirectory,
    session_history: [],
    knowledge_base: knowledgeBase,
    file_state: knowledgeBase.file_state,
    
    // NEW: Track solved issues
    solved_issues: [],
    
    // NEW: Track current blocking error
    current_blocking_error: null,
    
    // NEW: Error evolution history
    error_progression: [],
    
    // NEW: Action prevention
    recent_actions: [], // Last 5 actions to prevent repetition
    
    available_tools: AVAILABLE_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    environment_info: {
      os: process.platform,
      node_version: process.version,
      timestamp: new Date().toISOString()
    },
    constraints: {
      max_session_steps: 20,
      allowed_file_modifications: true,
      allowed_command_execution: true
    }
  };
}

/**
 * Parses error information from command output
 */
export function parseErrorFromOutput(output) {
  if (!output || typeof output !== 'string') return null;
  
  // Extract error type, message, file/line info
  const errorPatterns = [
    { type: 'ModuleNotFoundError', pattern: /ModuleNotFoundError: (.+)/ },
    { type: 'KeyError', pattern: /KeyError: (.+)/ },
    { type: 'FileNotFoundError', pattern: /FileNotFoundError: (.+)/ },
    { type: 'SyntaxError', pattern: /SyntaxError: (.+)/ },
    { type: 'ImportError', pattern: /ImportError: (.+)/ },
    { type: 'AttributeError', pattern: /AttributeError: (.+)/ },
    { type: 'ValueError', pattern: /ValueError: (.+)/ },
    { type: 'TypeError', pattern: /TypeError: (.+)/ },
    // Generic error patterns
    { type: 'Error', pattern: /Error: (.+)/ },
    { type: 'Exception', pattern: /Exception: (.+)/ }
  ];
  
  for (const { type, pattern } of errorPatterns) {
    const match = output.match(pattern);
    if (match) {
      return {
        type,
        message: match[1].trim(),
        raw_output: output,
        file_refs: extractFileReferences(output),
        line_refs: extractLineNumbers(output),
        timestamp: new Date().toISOString()
      };
    }
  }
  
  // Check for command not found errors
  if (output.includes('command not found') || output.includes('not recognized')) {
    return {
      type: 'CommandNotFound',
      message: output.trim(),
      raw_output: output,
      file_refs: [],
      line_refs: [],
      timestamp: new Date().toISOString()
    };
  }
  
  return null;
}

/**
 * Extracts file references from error output
 */
function extractFileReferences(output) {
  const filePattern = /File "([^"]+)"/g;
  const matches = [];
  let match;
  while ((match = filePattern.exec(output)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)]; // Remove duplicates
}

/**
 * Extracts line numbers from error output
 */
function extractLineNumbers(output) {
  const linePattern = /line (\d+)/g;
  const matches = [];
  let match;
  while ((match = linePattern.exec(output)) !== null) {
    matches.push(parseInt(match[1]));
  }
  return [...new Set(matches)]; // Remove duplicates
}

/**
 * Compares two errors to detect evolution
 */
export function compareErrors(previousError, currentError) {
  if (!previousError || !currentError) {
    return { 
      is_new_error: !!currentError && !previousError, 
      is_same_error: false,
      is_progression: false,
      resolution_status: currentError ? "new" : "resolved"
    };
  }
  
  const sameType = previousError.type === currentError.type;
  const sameMessage = previousError.message === currentError.message;
  const sameFiles = JSON.stringify(previousError.file_refs) === JSON.stringify(currentError.file_refs);
  
  return {
    is_same_error: sameType && sameMessage && sameFiles,
    is_progression: sameFiles && !sameType, // Same files, different error
    is_new_error: !sameType && !sameFiles,
    resolution_status: sameType && sameMessage ? "persisted" : 
                      sameFiles ? "progressed" : "evolved"
  };
}

/**
 * Updates error state based on new command output
 */
export function updateErrorState(context, newErrorOutput, currentStep) {
  const previousError = context.current_blocking_error;
  const parsedError = parseErrorFromOutput(newErrorOutput);
  
  // Record error progression
  context.error_progression.push({
    step: currentStep,
    error_detected: parsedError,
    previous_error: previousError,
    timestamp: new Date().toISOString()
  });
  
  if (!parsedError) {
    // No error found - previous issue might be resolved
    if (previousError) {
      context.solved_issues.push({
        ...previousError,
        resolution_step: currentStep,
        status: "resolved",
        resolved_at: new Date().toISOString()
      });
      context.current_blocking_error = null;
    }
    return context;
  }
  
  const errorComparison = compareErrors(previousError, parsedError);
  
  if (errorComparison.is_new_error || errorComparison.is_progression) {
    // New error detected - mark previous as resolved, focus on new one
    if (previousError) {
      context.solved_issues.push({
        ...previousError,
        resolution_step: currentStep - 1,
        status: "resolved",
        resolved_at: new Date().toISOString()
      });
    }
    context.current_blocking_error = {
      ...parsedError,
      first_seen_step: currentStep,
      status: "active"
    };
  } else if (errorComparison.is_same_error) {
    // Same error persisting - update the step where it was last seen
    context.current_blocking_error = {
      ...parsedError,
      first_seen_step: context.current_blocking_error?.first_seen_step || currentStep,
      last_seen_step: currentStep,
      status: "active"
    };
  }
  
  return context;
}

/**
 * Creates action signature for deduplication
 */
export function createActionSignature(toolName, parameters) {
  // Create a stable signature based on tool and key parameters
  const keyParams = { ...parameters };
  
  // Normalize file paths to relative paths for consistency
  if (keyParams.file_path) {
    keyParams.file_path = keyParams.file_path.replace(process.cwd(), '.');
  }
  if (keyParams.directory_path) {
    keyParams.directory_path = keyParams.directory_path.replace(process.cwd(), '.');
  }
  
  return `${toolName}:${JSON.stringify(keyParams, Object.keys(keyParams).sort())}`;
}

/**
 * Checks if an action should be skipped due to recent duplication
 */
export function shouldSkipAction(toolName, parameters, context) {
  const actionSignature = createActionSignature(toolName, parameters);
  const recentSteps = 3; // Look back 3 steps
  
  const recentDuplicate = context.recent_actions.find(action => 
    action.signature === actionSignature && 
    action.step > (context.session_history.length - recentSteps)
  );
  
  return {
    should_skip: !!recentDuplicate,
    duplicate_step: recentDuplicate?.step,
    reason: recentDuplicate ? 
      `Identical action performed in step ${recentDuplicate.step}` : 
      null
  };
}

/**
 * Updates agent context after tool execution
 */
export function updateAgentContext(context, step, thought, actionTaken, result) {
  const updatedContext = { ...context };
  
  // Add to session history
  updatedContext.session_history.push({
    step,
    thought,
    action_taken: actionTaken,
    result
  });
  
  // Track recent actions for deduplication
  const actionSignature = createActionSignature(
    actionTaken.tool_to_use || actionTaken.tool_used, 
    actionTaken.parameters
  );
  
  updatedContext.recent_actions.push({
    signature: actionSignature,
    step,
    tool: actionTaken.tool_to_use || actionTaken.tool_used,
    parameters: actionTaken.parameters,
    result
  });
  
  // Keep only last 10 actions to prevent memory bloat
  if (updatedContext.recent_actions.length > 10) {
    updatedContext.recent_actions = updatedContext.recent_actions.slice(-10);
  }
  
  // Update knowledge base based on result type
  if (result.status === "success") {
    // If we read a file, add to knowledge base
    if ((actionTaken.tool_used === "read_file_content" || actionTaken.tool_to_use === "read_file_content") && result.content) {
      updatedContext.knowledge_base.files_read[result.file_path] = result.content;
    }
    
    // Note: Error analysis is now done during initialization, not as a tool action
  }
  
  return updatedContext;
}

/**
 * Optimizes agent context for token efficiency
 */
export function optimizeAgentContext(agentContext, maxTokens = 8000) {
  const context = JSON.parse(JSON.stringify(agentContext)); // Deep clone
  
  // NEW: Focus mode - prioritize current error context
  if (context.current_blocking_error) {
    // Keep only relevant session history
    const relevantSteps = context.session_history.filter(step => 
      step.step > (context.session_history.length - 5) || // Last 5 steps
      (step.action_taken.tool_used === "propose_code_patch" || step.action_taken.tool_to_use === "propose_code_patch") || // Important actions
      (step.action_taken.tool_used === "propose_fix_by_command" || step.action_taken.tool_to_use === "propose_fix_by_command")
    );
    
    // If we removed too much, keep at least last 3 steps
    if (relevantSteps.length < 3 && context.session_history.length >= 3) {
      context.session_history = context.session_history.slice(-3);
    } else {
      context.session_history = relevantSteps;
    }
    
    // Keep only files relevant to current error
    const relevantFiles = context.current_blocking_error.file_refs || [];
    if (relevantFiles.length > 0) {
      Object.keys(context.knowledge_base.files_read).forEach(path => {
        const isRelevant = relevantFiles.some(ref => 
          path.includes(ref) || ref.includes(path.split('/').pop())
        );
        if (!isRelevant) {
          delete context.knowledge_base.files_read[path];
        }
      });
    }
    
    // Limit recent_actions to prevent bloat but keep deduplication capability
    if (context.recent_actions.length > 5) {
      context.recent_actions = context.recent_actions.slice(-5);
    }
  } else {
    // 1. Summarize old session history (keep last 3 steps full, summarize older)
    if (context.session_history.length > 5) {
      const recent = context.session_history.slice(-3);
      const older = context.session_history.slice(0, -3);
      
      const summary = `Previous ${older.length} steps: ` + older.map(step => 
        `Step ${step.step}: ${step.action_taken.tool_used || step.action_taken.tool_to_use} - ${step.result.status}`
      ).join(', ');
      
      context.session_history = [
        {
          step: "summary",
          summary,
          action_taken: { tool_used: "summary" },
          result: { status: "summarized" }
        },
        ...recent
      ];
    }
  }
  
  // 2. Limit files_read content (keep structure, truncate content)
  Object.keys(context.knowledge_base.files_read).forEach(path => {
    const content = context.knowledge_base.files_read[path];
    if (content && content.length > 2000) {
      context.knowledge_base.files_read[path] = 
        content.substring(0, 1000) + 
        "\n... [content truncated] ...\n" + 
        content.substring(content.length - 1000);
    }
  });
  
  // 3. Consolidate error_analysis_notes if too many
  if (context.knowledge_base.error_analysis_notes.length > 3) {
    const consolidated = context.knowledge_base.error_analysis_notes.join('\n\n');
    context.knowledge_base.error_analysis_notes = [
      `Consolidated analysis: ${consolidated.substring(0, 1500)}${consolidated.length > 1500 ? '...' : ''}`
    ];
  }
  
  // 4. Limit error_progression to recent entries
  if (context.error_progression && context.error_progression.length > 10) {
    context.error_progression = context.error_progression.slice(-10);
  }
  
  // 5. Keep available_tools with parameters for LLM guidance
  context.available_tools = context.available_tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters  // Keep parameters so LLM knows what to provide
  }));
  
  return context;
}

/**
 * Builds the complete prompt for the agent
 */
export function buildAgentPrompt(agentContext) {
  const optimizedContext = optimizeAgentContext(agentContext);
  
  // Build status summary for the agent
  let statusSummary = "";
  if (optimizedContext.solved_issues && optimizedContext.solved_issues.length > 0) {
    statusSummary += `\n✅ RESOLVED ISSUES (${optimizedContext.solved_issues.length}): `;
    statusSummary += optimizedContext.solved_issues.map(issue => 
      `${issue.type} (step ${issue.resolution_step})`
    ).join(', ');
    statusSummary += "\n⚠️ DO NOT work on resolved issues above!\n";
  }
  
  if (optimizedContext.current_blocking_error) {
    statusSummary += `\n🎯 CURRENT FOCUS: ${optimizedContext.current_blocking_error.type} - "${optimizedContext.current_blocking_error.message}"`;
    statusSummary += `\n   First seen: Step ${optimizedContext.current_blocking_error.first_seen_step}`;
    if (optimizedContext.current_blocking_error.file_refs?.length > 0) {
      statusSummary += `\n   Files involved: ${optimizedContext.current_blocking_error.file_refs.join(', ')}`;
    }
    statusSummary += "\n🎯 Work ONLY on the current blocking error above!\n";
  } else {
    statusSummary += "\n✅ No current blocking errors detected. Verify fixes or conclude session.\n";
  }
  
  // NEW: Add file state information to prompt
  if (optimizedContext.file_state) {
    statusSummary += `\n📁 AVAILABLE FILES: ${optimizedContext.file_state.discovered_files.join(', ')}`;
    if (optimizedContext.file_state.primary_error_file) {
      statusSummary += `\n🎯 PRIMARY FILE: ${optimizedContext.file_state.primary_error_file}`;
    }
    if (optimizedContext.file_state.file_mappings && Object.keys(optimizedContext.file_state.file_mappings).length > 0) {
      statusSummary += `\n🔗 FILE MAPPINGS: ${JSON.stringify(optimizedContext.file_state.file_mappings)}`;
    }
    statusSummary += "\n💡 Use these exact file names for all operations!\n";
  }
  
  
  // Add complete project structure  
  if (optimizedContext.knowledge_base.file_structure) {
    const fs = optimizedContext.knowledge_base.file_structure;
    statusSummary += `\n🌳 PROJECT STRUCTURE (${fs.metadata.total_files} total files, ${fs.metadata.relevant_files} relevant files):`;
    statusSummary += `\n📊 CONTENT: ${fs.metadata.code_files} code files + ${fs.metadata.relevant_files - fs.metadata.code_files} config/docs (${fs.metadata.filtered_out} filtered out)`;
    statusSummary += `\n📂 EXTENSIONS: ${fs.metadata.relevant_extensions.join(', ')}`;
    statusSummary += `\n📁 STRUCTURE: Complete hierarchy in knowledge_base.file_structure.tree_structure`;
    statusSummary += `\n📄 FILES: ${fs.metadata.relevant_files} debugging-relevant files in knowledge_base.file_structure.flat_files`;
  }
  
  // Add error analysis from pre-populated knowledge base
  const errorAnalysisNotes = optimizedContext.knowledge_base.error_analysis_notes || [];
  for (const note of errorAnalysisNotes) {
    if (note.type === 'traceback_analysis' && note.files_mentioned) {
      statusSummary += `\n🎯 ERROR FILES: ${note.files_mentioned.join(', ')}`;
    }
    if (note.type === 'initial_error_parse' && note.error) {
      statusSummary += `\n⚠️ PARSED ERROR: ${note.error.type} - ${note.error.message}`;
    }
  }
  
  const currentStep = optimizedContext.session_history.length + 1;
  
  const taskPrompt = `${statusSummary}

CURRENT CONTEXT:
${JSON.stringify(optimizedContext, null, 2)}

Choose your next action based on the above context. Focus on:
- The current_blocking_error (if any) - this is your PRIMARY focus
- Your solved_issues to avoid repeating successful actions
- Your recent_actions to avoid redundant work
- The initial_user_request and what the user is trying to achieve
- Information in your knowledge_base from previous investigations (directory listing, discovered files, error analysis)

Available tools: ${optimizedContext.available_tools.map(t => t.name).join(', ')}

CRITICAL REMINDERS:
1. WORKING CODE IS THE GOAL - Fix it fast using the pre-populated knowledge base
2. SPEED OVER ANALYSIS: Simple errors need simple fixes, not investigation
3. Focus ONLY on current_blocking_error (ignore historical errors) 
4. If you can see the fix in the error message, apply it immediately
5. AVOID over-analysis: aim for 2-3 steps total for simple errors
6. Every patch must result in EXECUTABLE CODE

IMPORTANT: Each tool requires specific parameters as shown in the available_tools section above.
For example:
- run_diagnostic_command requires: {"command_string": "the_actual_command"}
- read_file_content requires: {"file_path": "path/to/file"}

Respond with JSON only:`;

  return `${SYSTEM_PROMPT}\n\n${taskPrompt}`;
}

/**
 * Validates that agent context has required fields
 */
export function validateAgentContext(context) {
  const requiredFields = [
    'initial_user_request',
    'initial_command_run',
    'current_working_directory',
    'session_history',
    'knowledge_base',
    'available_tools'
  ];
  
  for (const field of requiredFields) {
    if (!(field in context)) {
      throw new Error(`Missing required field in agent context: ${field}`);
    }
  }
  
  return true;
}

/**
 * JSON schema for agent action output
 */
export const AGENT_ACTION_SCHEMA = {
  type: "object",
  properties: {
    thought: {
      type: "string",
      description: "Brief justification for the chosen action."
    },
    tool_to_use: {
      type: "string",
      description: "The name of the tool to execute from the available_tools list."
    },
    tool_parameters: {
      type: "object",
      description: "An object containing parameters for the chosen tool. Structure depends on the tool."
    }
  },
  required: ["thought", "tool_to_use", "tool_parameters"]
};

/**
 * Validates agent action response
 */
export function validateAgentAction(action) {
  if (!action || typeof action !== 'object') {
    return false;
  }
  
  const requiredFields = ['thought', 'tool_to_use', 'tool_parameters'];
  for (const field of requiredFields) {
    if (!(field in action)) {
      return false;
    }
  }
  
  if (typeof action.thought !== 'string' || 
      typeof action.tool_to_use !== 'string' || 
      typeof action.tool_parameters !== 'object') {
    return false;
  }
  
  // Check if tool exists
  const availableToolNames = AVAILABLE_TOOLS.map(t => t.name);
  if (!availableToolNames.includes(action.tool_to_use)) {
    return false;
  }
  
  // Validate file paths are not generic placeholders
  if (action.tool_to_use === 'read_file_content' && action.tool_parameters.file_path) {
    const filePath = action.tool_parameters.file_path;
    const invalidPaths = ['path/to/data', 'path/to/file', 'file.csv', 'data.csv'];
    if (invalidPaths.some(invalid => filePath.includes(invalid))) {
      console.log(`❌ Invalid generic file path: ${filePath}`);
      return false;
    }
  }
  
  if (action.tool_to_use === 'list_directory_contents' && action.tool_parameters.directory_path) {
    const dirPath = action.tool_parameters.directory_path;
    if (dirPath.includes('path/to/data') || dirPath.includes('path/to/file')) {
      console.log(`❌ Invalid generic directory path: ${dirPath}`);
      return false;
    }
  }
  
  return true;
}

/**
 * Creates a summary of session progress for user display
 */
export function createSessionSummary(agentContext) {
  const stepCount = agentContext.session_history.length;
  const toolsUsed = [...new Set(agentContext.session_history.map(step => 
    step.action_taken.tool_used || step.action_taken.tool_to_use
  ))];
  const filesAnalyzed = Object.keys(agentContext.knowledge_base.files_read).length;
  
  return {
    steps_taken: stepCount,
    tools_used: toolsUsed,
    files_analyzed: filesAnalyzed,
    current_status: stepCount === 0 ? 'starting' : 'investigating'
  };
}

/**
 * Checks if session should be terminated due to limits
 */
export function shouldTerminateSession(agentContext) {
  const maxSteps = agentContext.constraints?.max_session_steps || 20;
  const currentSteps = agentContext.session_history.length;
  
  if (currentSteps >= maxSteps) {
    return {
      should_terminate: true,
      reason: `Maximum session steps (${maxSteps}) reached`
    };
  }
  
  // Check for repeated failed actions
  const recentSteps = agentContext.session_history.slice(-3);
  const failedSteps = recentSteps.filter(step => step.result.status === 'error');
  
  if (failedSteps.length >= 3) {
    return {
      should_terminate: true,
      reason: "Multiple consecutive failures detected"
    };
  }
  
  return {
    should_terminate: false,
    reason: null
  };
}