/**
 * User File Extraction Utility
 * 
 * Extracts file paths mentioned by users in conversational input and reads their content.
 * Similar to traceback extraction but focused on natural language file mentions.
 */

import fs from 'fs';
import path from 'path';

/**
 * Recursively search for a file in subdirectories
 * @param {string} fileName - The filename to search for
 * @param {string} searchRoot - The root directory to search from
 * @param {number} maxDepth - Maximum search depth (default: 3)
 * @returns {string|null} Full path to the file if found, null otherwise
 */
function findFileInDirectories(fileName, searchRoot, maxDepth = 3) {
  try {
    function searchRecursive(dir, depth) {
      if (depth > maxDepth) return null;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      // First, check for exact file match in current directory
      for (const entry of entries) {
        if (entry.isFile() && entry.name === fileName) {
          return path.join(dir, entry.name);
        }
      }
      
      // Then, search subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && 
            !entry.name.startsWith('.') && 
            entry.name !== 'node_modules' && 
            entry.name !== '__pycache__' &&
            entry.name !== 'venv' &&
            entry.name !== '.git') {
          const result = searchRecursive(path.join(dir, entry.name), depth + 1);
          if (result) return result;
        }
      }
      
      return null;
    }
    
    return searchRecursive(searchRoot, 0);
  } catch (error) {
    // Directory not accessible or doesn't exist
    return null;
  }
}

/**
 * Extract file paths from user input using similar logic to extractFilesFromTraceback
 * @param {string} userInput - The user's conversational input
 * @param {string} projectRoot - Project root directory for resolving relative paths
 * @param {number} maxFiles - Maximum number of files to return (default: 3)
 * @returns {Map<string, Object>} Map of file paths to file info objects
 */
export function extractUserMentionedFiles(userInput, projectRoot = process.cwd(), maxFiles = 3) {
  const files = new Map();
  
  if (!userInput || typeof userInput !== 'string') {
    return files;
  }
  
  // File patterns that users might mention (similar to traceback patterns)
  const filePatterns = [
    // Quoted file paths: "file.js", 'config.py', `utils.ts`
    /["'`]([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)["'`]/g,
    
    // Backticked code mentions: `src/utils.js`, `./config.json`
    /`([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)`/g,
    
    // Common file extensions without quotes
    /\b([a-zA-Z0-9_\-]+\.(js|ts|py|json|html|css|java|cpp|c|h|rb|php|go|rs|swift|kt|scala|sh|yaml|yml|xml|md|txt))\b/g,
    
    // Relative path patterns: ./src/file.js, ../utils/helper.py
    /\b(\.{1,2}\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\b/g,
    
    // Absolute-like paths: src/components/App.tsx, utils/database.py
    /\b([a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\b/g,
  ];
  
  const foundPaths = new Set();
  
  // Extract all potential file paths
  for (const pattern of filePatterns) {
    const matches = userInput.matchAll(pattern);
    for (const match of matches) {
      const filePath = match[1];
      if (filePath && !foundPaths.has(filePath)) {
        foundPaths.add(filePath);
      }
    }
  }
  
  // Process found paths and check if they exist
  for (const filePath of foundPaths) {
    if (files.size >= maxFiles) {
      break; // Limit to maxFiles
    }
    
    let foundPath = null;
    
    // Try different path resolution strategies
    const pathsToTry = [
      filePath, // As-is
      path.resolve(projectRoot, filePath), // Relative to project root
      path.resolve(process.cwd(), filePath), // Relative to current working directory
    ];
    
    // If it's already an absolute path, don't try alternatives
    if (path.isAbsolute(filePath)) {
      pathsToTry.length = 1;
    }
    
    // First, try direct path resolution
    for (const fullPath of pathsToTry) {
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          foundPath = fullPath;
          break;
        }
      } catch (error) {
        // File not readable, continue to next path
        continue;
      }
    }
    
    // If not found with direct paths, try recursive search
    if (!foundPath) {
      const fileName = path.basename(filePath);
      
      // Search in project root first
      foundPath = findFileInDirectories(fileName, projectRoot, 3);
      
      // If still not found and we're in a different directory, search current directory too
      if (!foundPath && projectRoot !== process.cwd()) {
        foundPath = findFileInDirectories(fileName, process.cwd(), 3);
      }
    }
    
    if (foundPath) {
      try {
        // Read file content (first 200 lines)
        const content = fs.readFileSync(foundPath, 'utf8');
        const lines = content.split('\n');
        const truncatedLines = lines.slice(0, 200);
        const truncatedContent = truncatedLines.join('\n');
        
        // Create line-numbered version
        const withLineNumbers = truncatedLines
          .map((line, index) => `${index + 1}: ${line}`)
          .join('\n');
        
        files.set(filePath, {
          originalPath: filePath,
          fullPath: foundPath,
          content: truncatedContent,
          withLineNumbers: withLineNumbers,
          start: 1,
          end: Math.min(200, lines.length),
          totalLines: lines.length,
          exists: true,
          userMentioned: true
        });
      } catch (error) {
        // File not readable, continue to next file
        continue;
      }
    } else {
      // If file not found, still record it as mentioned but not existing
      files.set(filePath, {
        originalPath: filePath,
        fullPath: null,
        content: '',
        withLineNumbers: '',
        start: 0,
        end: 0,
        totalLines: 0,
        exists: false,
        userMentioned: true
      });
    }
  }
  
  return files;
}

/**
 * Filter user mentioned files to exclude those already included in RAG results
 * @param {Map} userFiles - User mentioned files from extractUserMentionedFiles
 * @param {Object} ragContext - RAG context with rootCauseFile and relatedFiles
 * @returns {Map} Filtered user files excluding RAG duplicates
 */
export function filterUserFilesExcludingRAG(userFiles, ragContext = null) {
  if (!ragContext) {
    return userFiles;
  }
  
  const ragFilePaths = new Set();
  
  // Collect RAG file paths
  if (ragContext.rootCauseFile && ragContext.rootCauseFile.path) {
    ragFilePaths.add(path.resolve(ragContext.rootCauseFile.path));
  }
  
  if (ragContext.relatedFiles && Array.isArray(ragContext.relatedFiles)) {
    for (const file of ragContext.relatedFiles) {
      if (file && file.path) {
        ragFilePaths.add(path.resolve(file.path));
      }
    }
  }
  
  // Filter out user files that are already in RAG results
  const filteredFiles = new Map();
  
  for (const [originalPath, fileInfo] of userFiles) {
    if (fileInfo.exists && fileInfo.fullPath) {
      const resolvedPath = path.resolve(fileInfo.fullPath);
      if (!ragFilePaths.has(resolvedPath)) {
        filteredFiles.set(originalPath, fileInfo);
      }
    } else if (!fileInfo.exists) {
      // Keep non-existing files for user feedback
      filteredFiles.set(originalPath, fileInfo);
    }
  }
  
  return filteredFiles;
}

/**
 * Get a summary of user mentioned files for display
 * @param {Map} userFiles - User mentioned files
 * @returns {Object} Summary with existing, missing, and total counts
 */
export function getUserFilesSummary(userFiles) {
  const existing = [];
  const missing = [];
  
  for (const [originalPath, fileInfo] of userFiles) {
    if (fileInfo.exists) {
      existing.push(originalPath);
    } else {
      missing.push(originalPath);
    }
  }
  
  return {
    existing,
    missing,
    total: userFiles.size,
    hasFiles: userFiles.size > 0
  };
} 