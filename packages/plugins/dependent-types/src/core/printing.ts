import type { MlttTerm } from "./terms";

export function printMlttTerm(term: MlttTerm): string {
  return printMlttTermWorker(term, []);
}


function printMlttTermWorker(term: MlttTerm, names: readonly string[]): string {
  switch (term.kind) {
    case "universe":
      return `Type${term.level}`;
    case "bool-type":
      return "Bool";
    case "true":
      return "True";
    case "false":
      return "False";
    case "bool-elim":
      return `BoolElim<${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.trueCase, names)}, ${printMlttTermWorker(term.falseCase, names)}, ${printMlttTermWorker(term.scrutinee, names)}>`;
    case "type-match":
      return `TypeMatch<${printMlttTermWorker(term.scrutinee, names)}, ${
        term.cases.map(matchCase => {
          const captureNames = (matchCase.captures ?? []).map(capture => capture.name);
          return `Case<${printMlttTermWorker(matchCase.pattern, [...captureNames, ...names])}, ${printMlttTermWorker(matchCase.result, [...captureNames, ...names])}>`;
        }).join(", ")
      }, Default<${printMlttTermWorker(term.defaultCase, names)}>>`;
    case "nat-type":
      return "Nat";
    case "zero":
      return "Zero";
    case "successor":
      return `Succ<${printMlttTermWorker(term.predecessor, names)}>`;
    case "nat-add":
      return `NatAdd<${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}>`;
    case "nat-elim":
      return `NatElim<${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.zeroCase, names)}, ${printMlttTermWorker(term.successorCase, names)}, ${printMlttTermWorker(term.scrutinee, names)}>`;
    case "identity-type":
      return `Eq<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}>`;
    case "refl":
      return `Refl<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.term, names)}>`;
    case "identity-elim":
      return `J<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.reflexivityCase, names)}, ${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}, ${printMlttTermWorker(term.equality, names)}>`;
    case "sigma": {
      const name = freshName(term.parameterName, names);
      return `Sigma<(${name}: ${printMlttTermWorker(term.domain, names)}) -> ${printMlttTermWorker(term.codomain, [name, ...names])}>`;
    }
    case "pair":
      return `Pair<${printMlttTermWorker(term.sigmaType, names)}, ${printMlttTermWorker(term.first, names)}, ${printMlttTermWorker(term.second, names)}>`;
    case "first":
      return `First<${printMlttTermWorker(term.pair, names)}>`;
    case "second":
      return `Second<${printMlttTermWorker(term.pair, names)}>`;
    case "variable":
      return names[term.index] ?? `#${term.index}`;
    case "pi": {
      const name = freshName(term.parameterName, names);
      return `(Pi (${name}: ${printMlttTermWorker(term.domain, names)}). ${printMlttTermWorker(term.codomain, [name, ...names])})`;
    }
    case "lambda": {
      const name = freshName(term.parameterName, names);
      return `(lambda ${name}. ${printMlttTermWorker(term.body, [name, ...names])})`;
    }
    case "application":
      return `(${printMlttTermWorker(term.functionTerm, names)} ${printMlttTermWorker(term.argument, names)})`;
    case "annotation":
      return `(${printMlttTermWorker(term.term, names)} : ${printMlttTermWorker(term.type, names)})`;
    case "external":
      return term.displayName;
  }
}

function freshName(preferredName: string, names: readonly string[]): string {
  const base = preferredName || "x";
  if (!names.includes(base)) return base;
  let suffix = 1;
  while (names.includes(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}






