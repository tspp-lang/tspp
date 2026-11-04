// The broken states a file passes through while it is typed, each named by a kind and a token position.

/** The file itself, then one character removed at each token and the text cut off at each token. */
function mutationPoints(text) {
  const points = [{ kind: "whole", at: 0 }];
  for (let at = 0; at < text.length; at++) {
    if (/\s/.test(text[at]) || (at > 0 && /\w/.test(text[at]) && /\w/.test(text[at - 1]))) continue;
    points.push({ kind: "delete", at }, { kind: "truncate", at });
  }
  return points;
}

function mutate(text, { kind, at }) {
  if (kind === "delete") return text.slice(0, at) + text.slice(at + 1);
  if (kind === "truncate") return text.slice(0, at);
  return text;
}

function describeMutation(text, { kind, at }) {
  const around = JSON.stringify(text.slice(Math.max(0, at - 16), at + 16).replace(/\s+/g, " "));
  if (kind === "delete") return `without the ${JSON.stringify(text[at])} of ${around}`;
  if (kind === "truncate") return `cut off at ${around}`;
  return "as written";
}

module.exports = { mutationPoints, mutate, describeMutation };
