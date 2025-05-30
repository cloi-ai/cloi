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
 * @returns {string} - The formatted prompt
 */
export function buildAnalysisPrompt(errorOutput, fileInfo = {}, codeSummary = '', filePath = '', context = '') {
  // Check for priority markers in the error output
  const hasPriority1 = errorOutput.includes('--- PRIORITY 1: USER PROVIDED CONTEXT ---');
  const hasPriority2 = errorOutput.includes('--- PRIORITY 2: TERMINAL OUTPUT WITH FILE PATHS ---');
  const hasPriority3 = errorOutput.includes('--- PRIORITY 3: TERMINAL OUTPUT ---');
  
  // Extract user provided context if available (highest priority)
  let userProvidedContext = '';
  if (hasPriority1) {
    const userContentMatch = errorOutput.match(/--- PRIORITY 1: USER PROVIDED CONTEXT ---\n([\s\S]*?)(?=\n---|$)/m);
    if (userContentMatch && userContentMatch[1]) {
      userProvidedContext = userContentMatch[1].trim();
    }
  }
  
  // Build the prompt with additional context
  let promptParts = [
    'Hey! You\'re a brilliant PhD-level debugging expert who gets genuinely excited about solving tricky errors. You love the detective work of figuring out what went wrong and helping people fix their code.',
    ''
  ];
  
  // Add user provided context first if available (highest priority)
  if (userProvidedContext) {
    promptParts.push('USER PROVIDED ERROR DETAILS (HIGHEST PRIORITY - FOCUS ON THIS FIRST):');
    promptParts.push(userProvidedContext);
    promptParts.push('');
    promptParts.push('IMPORTANT INSTRUCTION: The above user-provided error is the most accurate representation of the issue.');
    promptParts.push('You MUST focus primarily on analyzing this error, even if other errors appear in the output below.');
    promptParts.push('');
  }
  
  // Then add the regular error output with lower priority
  if (userProvidedContext) {
    promptParts.push('ADDITIONAL ERROR OUTPUT (LOWER PRIORITY):');
  } else {
    promptParts.push('ERROR OUTPUT:');
  }
  promptParts.push(errorOutput);
  promptParts.push('');
  
  promptParts.push('FILE PATH:');
  promptParts.push(filePath);
  promptParts.push('');
  
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
  promptParts.push('');
  
  // Add special instruction for prioritizing user-provided error details
  if (userProvidedContext) {
    promptParts.push('CRITICAL INSTRUCTION: Focus primarily on the USER PROVIDED ERROR DETAILS section above.');
    promptParts.push('This contains the exact error the user is experiencing and should be your main focus for analysis.');
    promptParts.push('Any additional error output should be considered secondary unless it directly relates to the user-provided error.');
    promptParts.push('');
  }
  
  promptParts.push('1. What went wrong');
  promptParts.push('Just tell me where the problem is and what\'s actually broken. Something like "index.js line 17: you\'re calling the wrong function name" or "config.js line 42: missing import". Keep it straightforward - I want to know the where and the what in one go.');
  promptParts.push('');
  promptParts.push('2. Proposed Fix');
  promptParts.push('Now show me how to fix it! Give me the actual solution with code if you need to. If there are multiple things to fix, just bundle them together. No "you could try this or that" - just tell me what to do.');
  promptParts.push('');
  promptParts.push('Be helpful and supportive - remember that debugging can be frustrating, so don\'t express excitement about errors or say things like "I love these bugs". Just be straightforward and helpful like a good colleague would be.');
  promptParts.push('');
  promptParts.push('Oh, and please just write normally - no fancy markdown formatting or anything. Just talk to me like we\'re sitting next to each other debugging this thing. For code, just indent it a bit or write it inline, whatever feels natural.');
  promptParts.push('');
  promptParts.push('Here\'s what I mean:');
  promptParts.push('1. What went wrong');
  promptParts.push('');
  promptParts.push('2. Proposed Fix');
  promptParts.push('IMPORTANT INSTRUCTION: The above user-provided error is the most accurate representation of the issue.');
  promptParts.push('You MUST focus primarily on analyzing this error, even if other errors appear in the output below.');
  promptParts.push('');
  promptParts.push('Make sure you nail down that exact line number even if the error message is being weird about it. Keep it focused and don\'t write a novel - we\'ve got bugs to squash!');
  
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
You are a helpful developer who is looking at code and explaining what you understand. Respond naturally like a human would when they're figuring out what code does.

CODE:
${codeContent}

Look at this code and explain what you understand in a natural, conversational way. Start with something like "Ah I see..." or "I understand this is..." or "Looking at this code..." and then briefly explain what it does. Keep it to 1-2 sentences maximum and sound like you're talking to a colleague.

Examples of good responses:
- "Ah I see, this is a user authentication function that validates login credentials and returns a JWT token."
- "I understand this code - it's setting up a React component that fetches user data and displays it in a table."
- "Looking at this, it appears to be a database migration script that adds a new 'email_verified' column to the users table."

Be conversational and human-like, not robotic. Limit your response to 2-3 sentences maximum.
`.trim();
} 