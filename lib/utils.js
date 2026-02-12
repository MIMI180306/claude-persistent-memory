/**
 * Minimal utility functions for the persistent memory system.
 * Extracted from .claude/scripts/lib/utils.js - only memory-relevant utilities.
 */

const fs = require('fs');
const path = require('path');

/**
 * Ensure a directory exists (create recursively if not).
 * @param {string} dirPath - Directory path to ensure
 * @returns {string} The directory path
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Calculate cosine similarity between two vectors.
 * @param {number[]} vec1 - First vector
 * @param {number[]} vec2 - Second vector
 * @returns {number} Similarity score between 0 and 1
 */
function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Log to stderr (visible to user in Claude Code, does not pollute stdout).
 * @param {string} message - Message to log
 */
function log(message) {
  console.error(message);
}

/**
 * Read a text file safely. Returns null if file does not exist or read fails.
 * @param {string} filePath - Absolute path to the file
 * @returns {string|null} File contents or null
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a text file. Parent directories are created automatically.
 * @param {string} filePath - Absolute path to the file
 * @param {string} content - Content to write
 */
function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Append to a text file. Parent directories are created automatically.
 * @param {string} filePath - Absolute path to the file
 * @param {string} content - Content to append
 */
function appendFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, 'utf8');
}

module.exports = {
  ensureDir,
  cosineSimilarity,
  log,
  readFile,
  writeFile,
  appendFile,
};
