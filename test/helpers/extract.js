// server.js is one large file that starts a server and schedules jobs when it loads, so it
// can't be required in a test. This pulls individual named functions (and simple constants)
// out of its source and runs them in an isolated context, so the real code is what gets tested.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// WINAI_SERVER_SRC lets a mutation check point the tests at a deliberately broken copy.
const SRC = fs.readFileSync(process.env.WINAI_SERVER_SRC || path.join(__dirname, '..', '..', 'server.js'), 'utf8');

// index just past the matching close of the bracket that opens at `open`, skipping strings and comments
function matchClose(src, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced brackets');
}

function functionSource(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC);
  if (!m) throw new Error(`function ${name} not found in server.js`);
  const params = SRC.indexOf('(', m.index + m[0].length - 1);
  const afterParams = matchClose(SRC, params);
  const body = SRC.indexOf('{', afterParams);
  return SRC.slice(m.index, matchClose(SRC, body));
}

function constSource(name) {
  const m = new RegExp(`^const ${name}\\s*=`, 'm').exec(SRC);
  if (!m) throw new Error(`const ${name} not found in server.js`);
  let i = m.index + m[0].length;
  while (/\s/.test(SRC[i])) i++;
  if ('{['.includes(SRC[i])) return SRC.slice(m.index, matchClose(SRC, i)) + ';';
  return SRC.slice(m.index, SRC.indexOf(';', i) + 1);
}

// extract({ functions: [...], consts: [...], globals: {...} }) -> object with the functions on it
function extract({ functions = [], consts = [], globals = {} } = {}) {
  const code = [...consts.map(constSource), ...functions.map(functionSource)].join('\n\n');
  const ctx = vm.createContext({ console, Math, Date, JSON, Number, parseFloat, parseInt, isFinite, Set, Map, Object, Array, String, ...globals });
  vm.runInContext(code + `\n;this.__exports = { ${[...functions, ...consts].join(', ')} };`, ctx);
  return ctx.__exports;
}

module.exports = { extract, functionSource };
