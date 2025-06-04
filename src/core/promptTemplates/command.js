/**
 * Prompt Template for Terminal Command Generation
 * 
 * This module builds prompts for LLM-based terminal command generation.
 */

/**
 * Creates a prompt for generating a terminal command fix
 * 
 * @param {string[]} prevCommands - Previous attempted fix commands
 * @param {string} analysis - Previous error analysis
 * @param {string} userContext - User's context/request for debugging
 * @returns {string} - The formatted prompt
 */
export function buildCommandFixPrompt(prevCommands, analysis, userContext = '') {
  const prevCommandsText = Array.isArray(prevCommands) && prevCommands.length > 0
    ? `\n\nPreviously tried commands:\n${prevCommands.map(cmd => `- ${cmd}`).join('\n')}`
    : '(none)';

  return `
You are a terminal command fixing AI. Given an analysis, extract a new command to fix it.
${userContext ? `\nUser Request:\n${userContext}\n` : ''}
Error Analysis:
${analysis}

Previous Commands:
${prevCommandsText}

Instructions:
1. Analyze the Proposed Fix section carefully
2. Extract a single command that will fix the issue
3. The command should be complete and ready to run
4. Do not include any explanations, commentary, or markdown formatting
5. Only output the command itself
${userContext ? '6. Ensure the command aligns with the user\'s request and goals\n' : ''}
Generate ONLY the command, nothing else. No explanations, no markdown, just the raw command.
Make sure it's valid syntax that can be directly executed in a terminal.
`.trim();
} 