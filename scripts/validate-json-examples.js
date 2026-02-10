#!/usr/bin/env node

/**
 * Validate all JSON examples in documentation
 */

const fs = require('fs');
const path = require('path');

const docsToCheck = [
  '../API_DOCUMENTATION.md',
  '../API_QUICK_START.md',
  '../README.md',
  '../SETUP.md'
];

const jsonBlockRegex = /```json\n([\s\S]*?)\n```/g;

let totalBlocks = 0;
let validBlocks = 0;
let invalidBlocks = 0;

console.log('🔍 Validating JSON examples in documentation...\n');

docsToCheck.forEach(docPath => {
  const fullPath = path.join(__dirname, docPath);
  
  if (!fs.existsSync(fullPath)) {
    console.log(`⏭️  Skipping ${docPath} (not found)`);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const matches = [...content.matchAll(jsonBlockRegex)];
  
  console.log(`📄 Checking ${path.basename(docPath)}...`);
  
  matches.forEach((match, index) => {
    totalBlocks++;
    const jsonText = match[1].trim();
    
    try {
      JSON.parse(jsonText);
      validBlocks++;
      console.log(`  ✅ Block ${index + 1}: Valid`);
    } catch (error) {
      invalidBlocks++;
      console.log(`  ❌ Block ${index + 1}: INVALID`);
      console.log(`     Error: ${error.message}`);
      console.log(`     Preview: ${jsonText.substring(0, 100)}...`);
      console.log('');
    }
  });
  
  console.log('');
});

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 Summary:`);
console.log(`   Total JSON blocks: ${totalBlocks}`);
console.log(`   Valid: ${validBlocks} ✅`);
console.log(`   Invalid: ${invalidBlocks} ❌`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (invalidBlocks > 0) {
  console.log('\n⚠️  Found invalid JSON examples! Please fix them.');
  process.exit(1);
} else {
  console.log('\n🎉 All JSON examples are valid!');
  process.exit(0);
}
