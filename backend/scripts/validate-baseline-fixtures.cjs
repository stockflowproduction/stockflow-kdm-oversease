const fs = require('fs');
const path = require('path');

const registryPath = path.resolve(__dirname, '../tests/harness/fixture-registry.ts');
const registrySource = fs.readFileSync(registryPath, 'utf8');

const groupsToCheck = ['products', 'customers', 'transactions_create'];

const extractPaths = (group) => {
  const regex = new RegExp(`group: '${group}'[\\s\\S]*?path: '([^']+)'`, 'g');
  const matches = [];
  let m;
  while ((m = regex.exec(registrySource)) !== null) {
    matches.push(m[1]);
  }
  return matches;
};

let hasFailure = false;
for (const group of groupsToCheck) {
  const paths = extractPaths(group);
  if (paths.length === 0) {
    hasFailure = true;
    continue;
  }

  for (const relPath of paths) {
    const full = path.resolve(__dirname, '..', relPath.replace(/^backend\//, ''));
    if (!fs.existsSync(full)) {
      hasFailure = true;
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!parsed.name) {
        hasFailure = true;
      }
    } catch (err) {
      hasFailure = true;
    }
  }
}

const requiredSpecs = [
  path.resolve(__dirname, '../tests/products/products-baseline.spec.ts'),
  path.resolve(__dirname, '../tests/customers/customers-baseline.spec.ts'),
  path.resolve(__dirname, '../tests/transactions/transactions-create-path.spec.ts'),
];

for (const spec of requiredSpecs) {
  if (!fs.existsSync(spec)) {
    hasFailure = true;
  }
}

if (hasFailure) {
  process.exit(1);
}

