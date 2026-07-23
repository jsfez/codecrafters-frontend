// Tiny reader for the one thing the Argos run needs from `.percy.yml`: the
// `percy-css` block, which freezes the timestamps that change on every run.
// Reading it here means the two tools stay in sync from a single source.
import fs from 'node:fs';

function percyCSS(configPath) {
  if (!fs.existsSync(configPath)) {
    return '';
  }

  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s*percy-css:\s*\|/.test(line));

  if (start === -1) {
    return '';
  }

  const indent = (lines[start].match(/^\s*/) || [''])[0].length;
  const block = [];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && (line.match(/^\s*/) || [''])[0].length <= indent) {
      break;
    }

    block.push(line);
  }

  return block.join('\n');
}

function disallowedHostnames(configPath) {
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s*disallowed-hostnames:\s*$/.test(line));

  if (start === -1) {
    return [];
  }

  const hosts = [];

  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*-\s*([^\s#]+)/);

    if (!match) {
      break;
    }

    hosts.push(match[1]);
  }

  return hosts;
}

export default { percyCSS, disallowedHostnames };
