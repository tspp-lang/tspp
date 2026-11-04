// A finding names the rule it breaks and the place, so that a failure reads as a to-do item rather than a colour dispute.
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

const finding = (rule, relative, text, offset, message) => ({ rule, location: `${relative}:${lineOf(text, offset)}`, message });

function formatFindings(findings, { limitPerRule = Infinity } = {}) {
  const byRule = new Map();
  for (const item of findings) byRule.set(item.rule, [...byRule.get(item.rule) ?? [], item]);
  const lines = [];
  for (const [rule, items] of [...byRule].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`\n${rule}: ${items.length}`);
    for (const item of items.slice(0, limitPerRule)) lines.push(`  ${item.location}  ${item.message}`);
    if (items.length > limitPerRule) lines.push(`  ... ${items.length - limitPerRule} more`);
  }
  return lines.join("\n");
}

module.exports = { finding, formatFindings };
