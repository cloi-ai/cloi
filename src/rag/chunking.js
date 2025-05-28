/**
 * Code Chunking Module
 * 
 * Provides utilities for breaking code files into semantically meaningful chunks
 * that can be embedded and indexed for retrieval. This module is critical for
 * ensuring that the RAG system can effectively locate the root source of issues.
 */

import fs from 'fs';
import path from 'path';

// Configuration
const DEFAULT_CHUNK_SIZE = 200; // Default number of lines per chunk
const DEFAULT_CHUNK_OVERLAP = 50; // Default number of overlapping lines
const MIN_CHUNK_SIZE = 10; // Minimum chunk size in lines

/**
 * Chunk a code file into semantically meaningful segments
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file
 * @param {Object} options - Chunking options
 * @returns {Array<Object>} Array of chunk objects with metadata
 */
export async function chunkCodeFile(filePath, content, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    chunkOverlap = DEFAULT_CHUNK_OVERLAP,
    fileType = path.extname(filePath).toLowerCase(),
    preserveSemantics = true
  } = options;

  // Split content into lines
  const lines = content.split('\n');
  
  // Use semantic boundaries if requested and available for this file type
  if (preserveSemantics) {
    return createSemanticChunks(filePath, lines, fileType, chunkSize, chunkOverlap);
  }
  
  // Fall back to fixed-size chunking
  return createFixedSizeChunks(filePath, lines, chunkSize, chunkOverlap);
}

/**
 * Create chunks based on semantic boundaries in the code
 * @param {string} filePath - Path to the file
 * @param {Array<string>} lines - Lines of code
 * @param {string} fileType - File extension
 * @param {number} maxChunkSize - Maximum chunk size in lines
 * @param {number} chunkOverlap - Number of overlapping lines
 * @returns {Array<Object>} Array of chunk objects
 */
function createSemanticChunks(filePath, lines, fileType, maxChunkSize, chunkOverlap) {
  // Detect semantic boundaries based on file type
  const boundaries = detectSemanticBoundaries(lines, fileType);
  
  // If no boundaries found, fall back to fixed-size chunking
  if (boundaries.length === 0) {
    return createFixedSizeChunks(filePath, lines, maxChunkSize, chunkOverlap);
  }
  
  const chunks = [];
  let currentChunk = [];
  let currentChunkStart = 0;
  let importSection = [];
  let importSectionEnd = 0;
  
  // Extract import section if present
  importSectionEnd = findImportSectionEnd(lines, fileType);
  if (importSectionEnd > 0) {
    importSection = lines.slice(0, importSectionEnd);
  }
  
  // Process each semantic boundary
  for (let i = 0; i < boundaries.length; i++) {
    const { start, end, type } = boundaries[i];
    
    // If adding this section would make the chunk too large, finalize current chunk
    if (currentChunk.length > 0 && (end - start + currentChunk.length) > maxChunkSize) {
      // Add chunk with metadata
      chunks.push(createChunkObject(
        filePath,
        currentChunkStart,
        currentChunkStart + currentChunk.length - 1,
        currentChunk.join('\n'),
        importSection
      ));
      
      // Start a new chunk with overlap
      const overlapStart = Math.max(0, currentChunk.length - chunkOverlap);
      currentChunk = currentChunk.slice(overlapStart);
      currentChunkStart += overlapStart;
    }
    
    // Add this section to the current chunk
    currentChunk = currentChunk.concat(lines.slice(start, end + 1));
    
    // If this is the first section in the chunk, update start position
    if (currentChunk.length === (end - start + 1)) {
      currentChunkStart = start;
    }
  }
  
  // Add the final chunk if not empty
  if (currentChunk.length > 0) {
    chunks.push(createChunkObject(
      filePath,
      currentChunkStart,
      currentChunkStart + currentChunk.length - 1,
      currentChunk.join('\n'),
      importSection
    ));
  }
  
  return chunks;
}

/**
 * Create fixed-size chunks from lines of code
 * @param {string} filePath - Path to the file
 * @param {Array<string>} lines - Lines of code
 * @param {number} chunkSize - Chunk size in lines
 * @param {number} chunkOverlap - Number of overlapping lines
 * @returns {Array<Object>} Array of chunk objects
 */
function createFixedSizeChunks(filePath, lines, chunkSize, chunkOverlap) {
  const chunks = [];
  let importSection = [];
  let importSectionEnd = 0;
  
  // Extract import section if present
  importSectionEnd = findImportSectionEnd(lines, path.extname(filePath).toLowerCase());
  if (importSectionEnd > 0) {
    importSection = lines.slice(0, importSectionEnd);
  }
  
  // Create chunks with overlap
  for (let i = 0; i < lines.length; i += (chunkSize - chunkOverlap)) {
    const end = Math.min(i + chunkSize, lines.length);
    const chunkLines = lines.slice(i, end);
    
    // Only create chunk if it meets minimum size
    if (chunkLines.length >= MIN_CHUNK_SIZE) {
      chunks.push(createChunkObject(
        filePath,
        i,
        end - 1,
        chunkLines.join('\n'),
        importSection
      ));
    }
    
    // If we've reached the end of the file, break
    if (end === lines.length) break;
  }
  
  return chunks;
}

/**
 * Create a chunk object with metadata
 * @param {string} filePath - Path to the file
 * @param {number} startLine - Start line number (0-indexed)
 * @param {number} endLine - End line number (0-indexed)
 * @param {string} content - Chunk content
 * @param {Array<string>} importSection - Import statements
 * @returns {Object} Chunk object
 */
function createChunkObject(filePath, startLine, endLine, content, importSection = []) {
  // Add import section to content if not already included
  let finalContent = content;
  if (importSection.length > 0 && startLine > importSection.length && !content.includes(importSection.join('\n'))) {
    finalContent = importSection.join('\n') + '\n\n// Main code section\n' + content;
  }
  
  return {
    filePath,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    content: finalContent,
    // Add display content for debugging/viewing (without imports)
    displayContent: content,
    // Add metadata for retrieval
    metadata: {
      fileName: path.basename(filePath),
      fileExt: path.extname(filePath).toLowerCase(),
      directory: path.dirname(filePath),
      hasImports: importSection.length > 0
    }
  };
}

/**
 * Detect semantic boundaries in code (functions, classes, etc.)
 * @param {Array<string>} lines - Lines of code
 * @param {string} fileType - File extension
 * @returns {Array<Object>} Array of boundary objects with start and end lines
 */
function detectSemanticBoundaries(lines, fileType) {
  const boundaries = [];
  
  // Select the appropriate detector based on file type
  switch (fileType) {
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return detectJavaScriptBoundaries(lines);
    case '.py':
      return detectPythonBoundaries(lines);
    case '.java':
      return detectJavaBoundaries(lines);
    // Add more language-specific detectors as needed
    default:
      // For unsupported languages, use a simple heuristic
      return detectGenericBoundaries(lines);
  }
}

/**
 * Detect semantic boundaries in JavaScript/TypeScript code
 * @param {Array<string>} lines - Lines of code
 * @returns {Array<Object>} Array of boundary objects
 */
function detectJavaScriptBoundaries(lines) {
  const boundaries = [];
  let inFunction = false;
  let inClass = false;
  let braceCount = 0;
  let currentStart = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for function declarations
    if (!inFunction && !inClass && 
        (line.startsWith('function ') || 
         line.match(/^(async\s+)?function\*?\s+\w+\s*\(/) ||
         line.match(/^(export\s+)?(async\s+)?function\*?\s+\w+\s*\(/) ||
         line.match(/^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(?.*\)?\s*=>\s*\{/) ||
         line.match(/^(export\s+)(const|let|var)\s+\w+\s*=\s*(async\s+)?\(?.*\)?\s*=>\s*\{/) ||
         line.match(/^(export\s+)?(default\s+)?(async\s+)?function\*?\s+\w+\s*\(/))) {
      
      currentStart = i;
      inFunction = true;
      braceCount = countBraces(line);
    }
    // Check for class declarations
    else if (!inFunction && !inClass && 
             (line.startsWith('class ') || 
              line.match(/^export\s+(default\s+)?class\s+\w+/) ||
              line.match(/^export\s+(default\s+)?class\s+\w+\s+extends\s+\w+/))) {
      
      currentStart = i;
      inClass = true;
      braceCount = countBraces(line);
    }
    // Count braces to track scope
    else if (inFunction || inClass) {
      braceCount += countBraces(line);
      
      // If braces are balanced, we've reached the end of the block
      if (braceCount === 0) {
        boundaries.push({
          start: currentStart,
          end: i,
          type: inFunction ? 'function' : 'class'
        });
        
        inFunction = false;
        inClass = false;
      }
    }
  }
  
  return boundaries;
}

/**
 * Detect semantic boundaries in Python code
 * @param {Array<string>} lines - Lines of code
 * @returns {Array<Object>} Array of boundary objects
 */
function detectPythonBoundaries(lines) {
  const boundaries = [];
  let inFunction = false;
  let inClass = false;
  let currentStart = 0;
  let indentLevel = 0;
  let currentIndent = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // Skip empty lines and comments
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }
    
    // Calculate indentation level
    const indent = line.length - line.trimStart().length;
    
    // Check for function definitions
    if (trimmedLine.startsWith('def ') || trimmedLine.match(/^async\s+def\s+\w+\s*\(/)) {
      if (!inFunction && !inClass) {
        currentStart = i;
        inFunction = true;
        indentLevel = indent;
        currentIndent = indent;
      }
    }
    // Check for class definitions
    else if (trimmedLine.startsWith('class ')) {
      if (!inFunction && !inClass) {
        currentStart = i;
        inClass = true;
        indentLevel = indent;
        currentIndent = indent;
      }
    }
    // Check indentation to track scope
    else if (inFunction || inClass) {
      // If this line has less or equal indentation than the definition,
      // we've reached the end of the block
      if (indent <= indentLevel && trimmedLine !== '') {
        boundaries.push({
          start: currentStart,
          end: i - 1,
          type: inFunction ? 'function' : 'class'
        });
        
        inFunction = false;
        inClass = false;
      } else {
        currentIndent = Math.max(currentIndent, indent);
      }
    }
  }
  
  // Handle case where function/class extends to end of file
  if (inFunction || inClass) {
    boundaries.push({
      start: currentStart,
      end: lines.length - 1,
      type: inFunction ? 'function' : 'class'
    });
  }
  
  return boundaries;
}

/**
 * Detect semantic boundaries in Java code
 * @param {Array<string>} lines - Lines of code
 * @returns {Array<Object>} Array of boundary objects
 */
function detectJavaBoundaries(lines) {
  const boundaries = [];
  let inMethod = false;
  let inClass = false;
  let braceCount = 0;
  let currentStart = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for method declarations
    if (!inMethod && 
        (line.match(/^(public|private|protected)?\s+(static\s+)?\w+(\[\])?\s+\w+\s*\(/) ||
         line.match(/^(public|private|protected)?\s+(abstract\s+)?\w+(\[\])?\s+\w+\s*\(/))) {
      
      currentStart = i;
      inMethod = true;
      braceCount = countBraces(line);
    }
    // Check for class declarations
    else if (!inMethod && !inClass && 
             (line.match(/^(public|private|protected)?\s+(abstract\s+)?class\s+\w+/) ||
              line.match(/^(public|private|protected)?\s+interface\s+\w+/) ||
              line.match(/^(public|private|protected)?\s+enum\s+\w+/))) {
      
      currentStart = i;
      inClass = true;
      braceCount = countBraces(line);
    }
    // Count braces to track scope
    else if (inMethod || inClass) {
      braceCount += countBraces(line);
      
      // If braces are balanced, we've reached the end of the block
      if (braceCount === 0) {
        boundaries.push({
          start: currentStart,
          end: i,
          type: inMethod ? 'method' : 'class'
        });
        
        inMethod = false;
        inClass = false;
      }
    }
  }
  
  return boundaries;
}

/**
 * Detect generic semantic boundaries for unsupported languages
 * @param {Array<string>} lines - Lines of code
 * @returns {Array<Object>} Array of boundary objects
 */
function detectGenericBoundaries(lines) {
  const boundaries = [];
  let braceCount = 0;
  let currentStart = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines and comments
    if (line === '' || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*')) {
      continue;
    }
    
    // Count braces to track potential blocks
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    
    // If we find an opening brace and we're not tracking a block yet
    if (openBraces > 0 && currentStart === -1) {
      currentStart = i;
    }
    
    braceCount += openBraces - closeBraces;
    
    // If braces are balanced and we were tracking a block
    if (braceCount === 0 && currentStart !== -1) {
      // Only consider blocks of reasonable size
      if (i - currentStart >= MIN_CHUNK_SIZE) {
        boundaries.push({
          start: currentStart,
          end: i,
          type: 'block'
        });
      }
      
      currentStart = -1;
    }
  }
  
  return boundaries;
}

/**
 * Count the net number of braces in a line
 * @param {string} line - Line of code
 * @returns {number} Net brace count (positive for more open, negative for more close)
 */
function countBraces(line) {
  const openBraces = (line.match(/\{/g) || []).length;
  const closeBraces = (line.match(/\}/g) || []).length;
  return openBraces - closeBraces;
}

/**
 * Find the end of the import section in a file
 * @param {Array<string>} lines - Lines of code
 * @param {string} fileType - File extension
 * @returns {number} Line number where imports end
 */
function findImportSectionEnd(lines, fileType) {
  let lastImportLine = -1;
  
  // Define import patterns based on file type
  let importPattern;
  switch (fileType) {
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      importPattern = /^import\s+|^require\s*\(/;
      break;
    case '.py':
      importPattern = /^import\s+|^from\s+\w+\s+import\s+/;
      break;
    case '.java':
      importPattern = /^import\s+/;
      break;
    default:
      // Generic pattern that might catch imports in various languages
      importPattern = /^import\s+|^require\s*\(|^from\s+\w+\s+import\s+|^using\s+/;
  }
  
  // Find the last import statement
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip empty lines and comments
    if (line === '' || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*')) {
      continue;
    }
    
    if (importPattern.test(line)) {
      lastImportLine = i;
    } else if (lastImportLine !== -1) {
      // If we've found imports before and this line is not an import,
      // check if it's just a blank line or comment
      if (line === '' || line.startsWith('//') || line.startsWith('#') || line.startsWith('/*')) {
        continue;
      } else {
        // We've found the first non-import, non-empty, non-comment line
        break;
      }
    }
  }
  
  return lastImportLine + 1;
}

/**
 * Determine optimal chunk size based on file type and content
 * @param {string} fileType - File extension
 * @param {string} content - File content
 * @returns {number} Optimal chunk size in lines
 */
export function determineOptimalChunkSize(fileType, content) {
  const lines = content.split('\n');
  
  // For very small files, use the whole file
  if (lines.length < DEFAULT_CHUNK_SIZE / 2) {
    return lines.length;
  }
  
  // For medium files, use default
  if (lines.length < DEFAULT_CHUNK_SIZE * 2) {
    return DEFAULT_CHUNK_SIZE;
  }
  
  // For large files, adjust based on file type
  switch (fileType) {
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      // JavaScript files often have smaller functions
      return 150;
    case '.py':
      // Python files can have varied function sizes
      return 200;
    case '.java':
      // Java files often have larger methods
      return 250;
    default:
      return DEFAULT_CHUNK_SIZE;
  }
}
