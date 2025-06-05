/**
 * Core LLM Functionality Module
 * 
 * Exposes high-level functions for LLM operations.
 * Acts as the central interface for all LLM interactions.
 */

// Import prompt templates
import { buildAnalysisPrompt, buildSummaryPrompt } from './promptTemplates/analyze.js';
import { buildErrorTypePrompt } from './promptTemplates/classify.js';
import { buildCommandFixPrompt } from './promptTemplates/command.js';
import { buildPatchPrompt } from './promptTemplates/patch.js';

// Import executor modules
import { routeModelQuery, routeStructuredQuery, ensureModelAvailable, getAllAvailableModels, getInstalledModels, installModelIfNeeded } from './executor/router.js';

// Import UI components
import { startThinking, getThinkingPhrasesForAnalysis, getThinkingPhrasesForPatch, getThinkingPhrasesForSummarization } from './ui/thinking.js';

// Import utilities
import { buildErrorContext, extractFilesFromTraceback, getErrorLines } from '../utils/traceback.js';
import { convertToUnifiedDiff } from '../utils/patch.js';
import chalk from 'chalk';

/**
 * Analyzes error output with an LLM
 * @param {string} errorOutput - The error output to analyze
 * @param {string} [model='phi4:latest'] - The model to use
 * @param {Object} [fileInfo={}] - Optional file information for context
 * @param {string} [codeSummary=''] - Optional code summary
 * @param {string} [filePath=''] - Optional file path
 * @param {string} [optimizationSet='error_analysis'] - The optimization set to use
 * @param {string} [userContext=''] - User's context/request for debugging
 * @returns {Promise<{analysis: string, reasoning: string, wasStreamed: boolean}>} - Analysis, reasoning and streaming flag
 */
export async function analyzeWithLLM(errorOutput, model = 'phi4:latest', fileInfo = {}, codeSummary = '', filePath = '', optimizationSet = 'error_analysis', userContext = '') {
  // Start thinking animation - fixed bottom for error_analysis
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis(), optimizationSet === 'error_analysis');
  
  try {
    await ensureModelAvailable(model);
    
    // Get traceback context if available
    const context = buildErrorContext(errorOutput, 30);
    
    // Build the analysis prompt
    const prompt = buildAnalysisPrompt(errorOutput, fileInfo, codeSummary, filePath, context, userContext);
    
    const max_tokens = 256;
    
    // Flag to track if response was streamed
    let wasStreamed = false;
    
    // Create a callback to stop the spinner when streaming begins
    const onStreamStart = () => {
      wasStreamed = true;
      stopThinking();
    };
    
    // Send the query to the appropriate model with the callback
    const result = await routeModelQuery(prompt, model, { temperature: 0.3, max_tokens, onStreamStart }, optimizationSet);
    
    // Since we're already streaming the output, we don't need to display it again
    // Just return it for further processing
    return {
      analysis: result.response,
      reasoning: result.reasoning,
      wasStreamed
    };
  } catch (error) {
    stopThinking();
    return {
      analysis: `Error during analysis: ${error.message}`,
      reasoning: '',
      wasStreamed: false
    };
  }
}

/**
 * Determines the type of error using LLM
 * @param {string} errorOutput - The error output
 * @param {string} analysis - Previous analysis of the error
 * @param {string} model - The model to use
 * @param {string} [userContext=''] - User's context/request for debugging
 * @returns {Promise<string>} - Either "TERMINAL_COMMAND_ERROR" or "CODE_FILE_ISSUE"
 */
export async function determineErrorType(errorOutput, analysis, model, userContext = '') {
  // First do a quick check for obvious terminal errors
  if (isTerminalCommandError(errorOutput)) {
    return "TERMINAL_COMMAND_ERROR";
  }
  
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis());
  
  try {
    await ensureModelAvailable(model);
    
    // Build the error type classification prompt
    const prompt = buildErrorTypePrompt(errorOutput, analysis, userContext);
    
    const max_tokens = 32;
    
    // Send the query to the appropriate model
    const result = await routeModelQuery(prompt, model, { temperature: 0.1, max_tokens }, 'error_determination');
    
    stopThinking();
    
    const cleanOutput = result.response.trim();
    const isTerminal = cleanOutput.includes('TERMINAL_COMMAND_ERROR');
    
    return isTerminal ? "TERMINAL_COMMAND_ERROR" : "CODE_FILE_ISSUE";
  } catch (error) {
    stopThinking();
    return "CODE_FILE_ISSUE"; // Default to code issue if error
  }
}

/**
 * Generates a terminal command to fix an error
 * @param {string[]} prevCommands - Previous attempted commands
 * @param {string} analysis - Previous error analysis
 * @param {string} model - The model to use
 * @param {string} [userContext=''] - User's context/request for debugging
 * @returns {Promise<{command: string, reasoning: string}>} - Generated command and reasoning
 */
export async function generateTerminalCommandFix(prevCommands, analysis, model, userContext = '') {
  const stopThinking = startThinking(getThinkingPhrasesForAnalysis());
  
  try {
    await ensureModelAvailable(model);
    
    // Build the command fix prompt
    const prompt = buildCommandFixPrompt(prevCommands, analysis, userContext);
    
    const max_tokens = 256;
    
    // Send the query to the appropriate model
    const result = await routeModelQuery(prompt, model, { temperature: 0.1, max_tokens }, 'command_generation');
    
    stopThinking();
    
    // Clean the output to get just the command
    let command = result.response.trim();
    
    // Remove markdown code blocks if present
    command = command.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '');
    
    // Remove any leading "Run: " or similar text
    command = command.replace(/^(Run|Execute|Type|Use|Try):\s*/i, '');
    
    // Remove any $ prefix (common in examples)
    command = command.replace(/^\$\s*/, '');
    
    return {
      command,
      reasoning: result.reasoning
    };
  } catch (error) {
    stopThinking();
    return {
      command: `echo "Error generating command: ${error.message}"`,
      reasoning: ''
    };
  }
}

/**
 * Generates a patch to fix code issues
 * @param {string} errorOutput - The error output
 * @param {string[]} prevPatches - Previous attempted patches
 * @param {string} analysis - Previous error analysis
 * @param {string} currentDir - Current working directory
 * @param {string} model - The model to use
 * @param {Object} fileInfo - Optional file information
 * @param {string} codeSummary - Optional code summary
 * @param {string} [userContext=''] - User's context/request for debugging
 * @returns {Promise<{diff: string, reasoning: string}>} - Generated diff and reasoning
 */
export async function generatePatch(
  errorOutput,
  prevPatches,
  analysis,
  currentDir = process.cwd(),
  model,
  fileInfo = {},
  codeSummary = '',
  userContext = ''
) {
  const stopThinking = startThinking(getThinkingPhrasesForPatch());
  
  try {
    await ensureModelAvailable(model);
    
    // Extract file paths and line numbers from the traceback
    const filesWithErrors = extractFilesFromTraceback(errorOutput);
    const errorFiles = Array.from(filesWithErrors.keys()).join('\n');
    const errorLines = Array.from(filesWithErrors.values()).join('\n');
    
    // Get the exact lines of code where errors occur
    const exactErrorCode = getErrorLines(errorOutput);
    
    // Get the code context with reduced context size (±3 lines)
    const context = buildErrorContext(errorOutput, 3, false);
    
    // Build the patch prompt
    const prompt = buildPatchPrompt(
      errorOutput,
      prevPatches,
      analysis,
      currentDir,
      fileInfo,
      codeSummary,
      errorFiles,
      errorLines,
      exactErrorCode,
      context,
      userContext
    );
    
    // Define schema for structured output
    const patchSchema = {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              line_number: { type: "integer" },
              old_line: { type: "string" },
              new_line: { type: "string", nullable: true }
            },
            required: ["file_path", "line_number", "old_line"]
          }
        },
        description: { type: "string" }
      },
      required: ["changes"]
    };
    
    // Try to use structured output if possible
    try {
      const structuredMaxTokens = 384;
      const jsonMaxTokens = 384;
      
      const structuredResult = await routeStructuredQuery(prompt, model, patchSchema, { 
        temperature: 0.1, 
        max_tokens: structuredMaxTokens 
      });
      
      // Get the reasoning from the model if available
      const modelResult = await routeModelQuery(prompt, model, { 
        temperature: 0.1,
        max_tokens: jsonMaxTokens
      }, 'patch_generation');
      
      stopThinking();
      
      // Convert the structured result to a proper unified diff
      let diff;
      try {
        // Check if structuredResult is valid for conversion
        if (structuredResult.error || !structuredResult.changes || !Array.isArray(structuredResult.changes)) {
          // Fall back to unstructured response
          diff = modelResult.response;
          console.log(chalk.yellow('Structured output invalid, falling back to text response'));
        } else {
          diff = convertToUnifiedDiff(structuredResult, currentDir);
        }
      } catch (error) {
        // If conversion fails, fall back to text response
        console.log(chalk.yellow(`Error converting to diff: ${error.message}`));
        diff = modelResult.response;
      }
      
      return {
        diff,
        reasoning: modelResult.reasoning || structuredResult.description || ''
      };
    } catch (error) {
      // Fall back to regular text generation
      const textMaxTokens = 768;
      
      const result = await routeModelQuery(prompt, model, { 
        temperature: 0.1, 
        max_tokens: textMaxTokens 
      }, 'patch_generation');
      
      stopThinking();
      
      return {
        diff: result.response,
        reasoning: result.reasoning
      };
    }
  } catch (error) {
    stopThinking();
    console.error(`Error generating patch: ${error.message}`);
    return {
      diff: '',
      reasoning: `Error generating patch: ${error.message}`
    };
  }
}

/**
 * Summarizes code content with an LLM
 * @param {string} codeContent - The code content to summarize
 * @param {string} model - The model to use
 * @returns {Promise<string>} - The summary
 */
export async function summarizeCodeWithLLM(codeContent, model) {
  const stopThinking = startThinking(getThinkingPhrasesForSummarization());
  
  try {
    await ensureModelAvailable(model);
    
    // Build the summary prompt
    const prompt = buildSummaryPrompt(codeContent);
    
    const max_tokens = 128;
    
    // Send the query to the appropriate model
    const result = await routeModelQuery(prompt, model, { temperature: 0.3, max_tokens }, 'error_analysis');
    
    stopThinking();
    return result.response.trim();
  } catch (error) {
    stopThinking();
    return `Error during summarization: ${error.message}`;
  }
}

/**
 * Checks if an error is likely related to a terminal command issue
 * @param {string} errorOutput - The error output to analyze
 * @returns {boolean} - True if it seems to be a terminal command issue
 */
function isTerminalCommandError(errorOutput) {
  const terminalErrors = [
    /command not found/i,
    /no such file or directory/i,
    /permission denied/i,
    /not installed/i,
    /invalid option/i,
    /unknown option/i,
    /missing argument/i,
    /too many arguments/i,
    /not recognized as an internal or external command/i,
    /is not recognized as a command/i,
  ];
  
  return terminalErrors.some(pattern => pattern.test(errorOutput));
}

/**
 * Determines the next action for the agentic debugging assistant
 * @param {Object} agentContext - The current context of the debugging session
 * @param {string} model - The model to use for decision making
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<{thought: string, tool_to_use: string, tool_parameters: Object}>} - The agent's chosen action
 */
export async function determineNextAgentAction(agentContext, model, maxRetries = 3) {
  const { buildAgentPrompt, validateAgentAction, AGENT_ACTION_SCHEMA } = await import('./agent_prompt.js');
  const stopThinking = startThinking(['🤖 Agent thinking...', '🔍 Analyzing context...', '⚡ Planning next action...']);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureModelAvailable(model);
      
      // Build the prompt for the agent
      const prompt = buildAgentPrompt(agentContext);
      
      // Call the LLM with structured output
      const result = await routeStructuredQuery(prompt, model, AGENT_ACTION_SCHEMA, {
        temperature: 0.1,
        max_tokens: 256
      });
      
      stopThinking();
      
      // Validate the response
      if (!validateAgentAction(result)) {
        throw new Error(`Invalid action format: ${JSON.stringify(result)}`);
      }
      
      // Validate tool exists
      const { AVAILABLE_TOOLS } = await import('./agent_tools.js');
      const availableTools = AVAILABLE_TOOLS.map(t => t.name);
      if (!availableTools.includes(result.tool_to_use)) {
        throw new Error(`Unknown tool: ${result.tool_to_use}`);
      }
      
      return result;
      
    } catch (error) {
      console.log(chalk.yellow(`Agent decision attempt ${attempt} failed: ${error.message}`));
      
      if (attempt === maxRetries) {
        stopThinking();
        // Fallback: return a safe diagnostic action
        return {
          thought: `Failed to get valid agent decision after ${maxRetries} attempts. Asking user for guidance.`,
          tool_to_use: "ask_user_for_clarification",
          tool_parameters: {
            question_for_user: `I encountered an error making a decision: ${error.message}. Could you please describe what you'd like me to do next?`
          }
        };
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Export model management functions
export {
  getAllAvailableModels,
  getInstalledModels,
  installModelIfNeeded,
  ensureModelAvailable
}; 