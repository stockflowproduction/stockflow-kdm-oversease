const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

for (const file of walk(path.join(process.cwd(), '.tmp-tests'))) {
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace(/from\s+['"](\.{1,2}\/[^'"\n]+?)['"]/g, (m, spec) => {
    if (/\.(js|mjs|cjs|json)$/.test(spec)) return m;
    return m.replace(spec, spec + '.js');
  });
  fs.writeFileSync(file, text);
}
