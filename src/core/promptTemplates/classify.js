/**
 * Prompt Template for Error Type Classification
 * 
 * This module builds prompts for classifying whether an error is a terminal command issue
 * or a code file issue that needs patching.
 */

/**
 * Creates a prompt for error type classification
 * 
 * @param {string} errorOutput - The raw error output from command execution
 * @param {string} analysis - Previous analysis of the error
 * @param {string} userContext - Optional user context for debugging focus
 * @returns {string} - The formatted prompt for LLM
 */
export function buildErrorTypePrompt(errorOutput, analysis, userContext = '') {
  let prompt = `You are analyzing an error to determine if it's a terminal command issue or a code file issue.

ERROR OUTPUT:
${errorOutput}

ANALYSIS:
${analysis}`;

  if (userContext) {
    prompt += `

USER CONTEXT:
${userContext}`;
  }

  prompt += `

Classify this error as either:
- TERMINAL_COMMAND_ERROR: Wrong command, missing dependencies, incorrect arguments, etc.
- CODE_FILE_ISSUE: Bugs in the actual source code that need fixing

Respond with exactly one of these two options and nothing else.`;

  return prompt;
} 