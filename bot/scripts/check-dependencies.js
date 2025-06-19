#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Checking dependencies...\n');

// Check if node_modules exists
const nodeModulesPath = path.join(process.cwd(), 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.log('❌ node_modules not found. Running npm install...');
  try {
    execSync('npm install', { stdio: 'inherit' });
    console.log('✅ Dependencies installed successfully');
  } catch (error) {
    console.error('Failed to install dependencies:', error);
    process.exit(1);
  }
} else {
  console.log('✅ node_modules found');
}

// Check for required dependencies
const requiredDeps = [
  'ethers',
  'winston',
  'dotenv',
  'ws'
];

let missingDeps = [];

for (const dep of requiredDeps) {
  const depPath = path.join(nodeModulesPath, dep);
  if (!fs.existsSync(depPath)) {
    missingDeps.push(dep);
  }
}

if (missingDeps.length > 0) {
  console.log(`❌ Missing dependencies: ${missingDeps.join(', ')}`);
  console.log('Running npm install...');
  try {
    execSync('npm install', { stdio: 'inherit' });
    console.log('✅ Dependencies installed successfully');
  } catch (error) {
    console.error('Failed to install dependencies:', error);
    process.exit(1);
  }
} else {
  console.log('✅ All required dependencies are installed');
}

console.log('\n✅ Dependency check passed!');
process.exit(0);