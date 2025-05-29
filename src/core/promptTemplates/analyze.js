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
 * @param {string} userContext - Optional user context for debugging focus
 * @returns {string} - The formatted prompt
 */
export function buildAnalysisPrompt(errorOutput, fileInfo = {}, codeSummary = '', filePath = '', context = '', userContext = '') {
  // Build the prompt with additional context
  let promptParts = [
    'Hey! You\'re a brilliant PhD-level debugging expert who gets genuinely excited about solving tricky errors. You love the detective work of figuring out what went wrong and helping people fix their code.',
    '',
    'ERROR OUTPUT:',
    errorOutput,
    '',
    'FILE PATH:',
    filePath,
  ];
  
  // Add user context at the beginning if provided
  if (userContext) {
    promptParts.splice(2, 0, 'USER CONTEXT:', userContext, '');
  }
  
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
  
  // Add RAG root cause information if available
  if (fileInfo && fileInfo.ragRootCause) {
    promptParts.push('RAG ANALYSIS - ROOT CAUSE IDENTIFIED:');
    promptParts.push(fileInfo.ragRootCause);
    promptParts.push('');
  }
  
  // Add RAG related files if available
  if (fileInfo && fileInfo.ragRelatedFiles) {
    promptParts.push('RAG ANALYSIS - RELATED FILES:');
    promptParts.push(fileInfo.ragRelatedFiles);
    promptParts.push('');
  }
  
  // Add RAG enhanced content if available
  if (fileInfo && fileInfo.ragEnhancedContent) {
    promptParts.push('RAG ENHANCED CONTEXT:');
    promptParts.push(fileInfo.ragEnhancedContent);
    promptParts.push('');
  }
  
  // Add traceback context if available
  if (context) {
    promptParts.push('TRACEBACK CONTEXT (±30 lines):');
    promptParts.push(context);
    promptParts.push('');
  }
  
  // Add instructions
  promptParts.push('Alright, time to work your debugging magic! I need you to break this down into two simple parts:');
  
  // Add user-focused instruction if context provided
  if (userContext) {
    promptParts.push('');
    promptParts.push(`IMPORTANT: Pay special attention to the user's request above: "${userContext}". Focus your analysis on this aspect while still providing a complete solution.`);
  }
  
  promptParts.push('');
  promptParts.push('1. What went wrong');
  promptParts.push('Just tell me where the problem is and what\'s actually broken. Something like "index.js line 17: you\'re calling the wrong function name" or "config.js line 42: missing import". Keep it straightforward - I want to know the where and the what in one go.');
  promptParts.push('');
  promptParts.push('2. Proposed Fix');
  promptParts.push('Now show me how to fix it! Give me the actual solution with code if you need to. If there are multiple things to fix, just bundle them together. No "you could try this or that" - just tell me what to do.');
  
  // Add user context acknowledgment if provided
  if (userContext) {
    promptParts.push('');
    promptParts.push(`Remember to address the user's specific concern: "${userContext}" in your response.`);
  }
  
  promptParts.push('');
  promptParts.push('Be helpful and supportive - remember that debugging can be frustrating, so don\'t express excitement about errors or say things like "I love these bugs". Just be straightforward and helpful like a good colleague would be.');
  promptParts.push('');
  promptParts.push('Oh, and please just write normally - no fancy markdown formatting or anything. Just talk to me like we\'re sitting next to each other debugging this thing. For code, just indent it a bit or write it inline, whatever feels natural.');
  promptParts.push('');
  promptParts.push('Here\'s what I mean:');
  promptParts.push('1. What went wrong');
  promptParts.push('You\'re trying to access user.email in main.py on line 23 but user is None because the database query failed.');
  promptParts.push('');
  promptParts.push('2. Proposed Fix');
  promptParts.push('Add a null check before accessing user properties. Change line 23 from:');
  promptParts.push('    return user.email');
  promptParts.push('to:');
  promptParts.push('    return user.email if user else "No user found"');
  promptParts.push('');
  promptParts.push('Make sure you nail down that exact line number even if the error message is being weird about it. Keep it focused and don\'t write a novel - we\'ve got bugs to squash!');
  
  return promptParts.join('\n');
}

/**
 * Creates a prompt for summarizing code context
 * 
 * @param {string} codeContent - The code content to summarize
 * @param {string} userContext - Optional user context for debugging focus
 * @returns {string} - The formatted prompt
 */
export function buildSummaryPrompt(codeContent, userContext = '') {
  let prompt = `
You are a helpful developer who is looking at code and explaining what you understand. Respond naturally like a human would when they're figuring out what code does.

CODE:
${codeContent}`;

  if (userContext) {
    prompt += `

USER CONTEXT:
${userContext}`;
  }

  prompt += `

Look at this code and explain what you understand in a natural, conversational way. Start with something like "Ah I see..." or "I understand this is..." or "Looking at this code..." and then briefly explain what it does. Keep it to 1-2 sentences maximum and sound like you're talking to a colleague.`;

  if (userContext) {
    prompt += ` Pay special attention to the user's concern: "${userContext}" and mention it if relevant to the code.`;
  }

  prompt += `

Examples of good responses:
- "Ah I see, this is a user authentication function that validates login credentials and returns a JWT token."
- "I understand this code - it's setting up a React component that fetches user data and displays it in a table."
- "Looking at this, it appears to be a database migration script that adds a new 'email_verified' column to the users table."

Be conversational and human-like, not robotic. Limit your response to 2-3 sentences maximum.`;

  return prompt.trim();
} 