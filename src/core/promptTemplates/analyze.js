/**
 * Prompt Template for Error Analysis
 * 
 * This module builds prompts for LLM-based error analysis.
 */

/**
 * Creates a prompt for error analysis with all available context
 * 
 * @param {string} errorOutput - The error output to analyze
 * @param {Object} fileInfo - Optional file information for additional context
 * @param {string} fileInfo.content - File content as plain text
 * @param {string} fileInfo.withLineNumbers - File content with line numbers
 * @param {number} fileInfo.start - Starting line number
 * @param {number} fileInfo.end - Ending line number
 * @param {string} fileInfo.path - File path
 * @param {string} codeSummary - Optional code summary
 * @param {string} filePath - Optional file path
 * @param {string} context - Optional traceback context
 * @param {string} userContext - User's context/request for debugging
 * @returns {string} - The formatted prompt
 */
export function buildAnalysisPrompt(errorOutput, fileInfo = {}, codeSummary = '', filePath = '', context = '', userContext = '') {
  // Build the prompt with additional context
  let promptParts = [
    'You are a helpful terminal assistant analysing command errors.',
    '',
  ];

  // Add user context if provided
  if (userContext) {
    promptParts.push('USER REQUEST:');
    promptParts.push(userContext);
    promptParts.push('');
  }

  promptParts.push('ERROR OUTPUT:');
  promptParts.push(errorOutput);
  promptParts.push('');
  promptParts.push('FILE PATH:');
  promptParts.push(filePath);
  
  // Add code summary if provided
  if (codeSummary) {
    promptParts.push('CODE SUMMARY:');
    promptParts.push(codeSummary);
    promptParts.push('');
  }
  
  // Add file content if provided
  if (fileInfo && (fileInfo.withLineNumbers || fileInfo.content)) {
    const content = fileInfo.withLineNumbers || fileInfo.content || '';
    const start = fileInfo.start || 1;
    const end = fileInfo.end || (content ? content.split('\n').length : 1);
    promptParts.push(`FILE CONTENT (lines ${start}-${end}):`);
    promptParts.push(content);
    promptParts.push('');
  }
  
  // Add traceback context if available
  if (context) {
    promptParts.push('TRACEBACK CONTEXT (±30 lines):');
    promptParts.push(context);
    promptParts.push('');
  }
  
  // Add instructions
  promptParts.push('Your response MUST include these sections:');
  promptParts.push('1. ERROR LOCATION: Specify the file name (example.py) and the exact line number (line 45) where you believe the error is occurring. Nothing else.');
  promptParts.push('2. Explain **VERY** concisely what went wrong.');
  promptParts.push('3. FIX: Propose a concrete solution to fix the error. There might be multiple fixes required for the same error, so put all in one code chunk. Do not move onto another error. No alternatives. Be final with your solution.');
  
  if (userContext) {
    promptParts.push('4. Consider the user\'s request above when proposing the fix to ensure it aligns with their goals.');
  }
  
  promptParts.push('');
  promptParts.push('Be precise about the error line number, even if it\'s not explicitly mentioned in the traceback.');
  promptParts.push('No to low explanation only and focused on the root cause and solution. Keep it **VERY** concise.');
  
  return promptParts.join('\n');
}

/**
 * Creates a prompt for summarizing code context
 * 
 * @param {string} codeContent - The code content to summarize
 * @returns {string} - The formatted prompt
 */
export function buildSummaryPrompt(codeContent) {
  return `
You are a concise code summarization assistant.

CODE:
${codeContent}

Provide an ultra-concise summary of this code in EXACTLY 1-2 lines maximum. Your summary must:
- Describe the main purpose/functionality
- Mention key components or patterns if relevant
- Be immediately useful to a developer skimming the code
- Not exceed 2 lines under any circumstances

Your entire response should be 1-2 lines only. No introductions, explanations, or lists. Make it concise and to the point.
`.trim();
} 