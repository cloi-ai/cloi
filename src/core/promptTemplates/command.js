/**
 * Prompt Template for Terminal Command Generation
 * 
 * This module builds prompts for generating terminal commands to fix errors.
 */

/**
 * Creates a prompt for generating terminal command fixes
 * 
 * @param {string[]} prevCommands - Previous attempted commands (if any)
 * @param {string} analysis - Analysis of the error
 * @param {string} userContext - Optional user context for debugging focus
 * @returns {string} - The formatted prompt
 */
export function buildCommandFixPrompt(prevCommands, analysis, userContext = '') {
  let prompt = `You are a terminal command expert. Generate a single command to fix this error.

ANALYSIS:
${analysis}`;

  if (userContext) {
    prompt += `

USER CONTEXT:
${userContext}`;
  }

  if (prevCommands && prevCommands.length > 0) {
    prompt += `

PREVIOUS ATTEMPTS (these failed):
${prevCommands.join('\n')}`;
  }

  prompt += `

Generate ONE terminal command that will fix this issue. Examples:
- pip install requests
- npm install express
- sudo apt update && sudo apt install python3-dev

Requirements:
1. Output ONLY the command, no explanations
2. Make it runnable as-is
3. Don't include $ or prompt symbols`;

  if (userContext) {
    prompt += `
4. Consider the user's specific concern: "${userContext}"`;
  }

  prompt += `

Command:`;

  return prompt;
} 