import type * as TS from "typescript-upstream";
import { nameText, nodeStart, ts } from "./host-api";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import type { TSPPAnalysisDiagnostic } from "@tspp/plugin-sdk/compiler";
import { expressionToSmtTerm, isNumericSort, smtSort, strictlyLessThan, stringLengthTerm, stringTerm, termForSort, type Term } from "./expression";
import { reportWithClauseIssues, type PendingProof } from "./contracts";
import { immediatelyInvoked, lowerCallArguments, lowerConditional, lowerImmediateCall, lowerPositionalField, lowerStructuredResult, type Lowering } from "./lowered-code";
import { refinementTerm, reportMisplacedRefinements } from "./refinements";
import type { LogicLibrary } from "./logic";
import { collectTopLevelProofVariables } from "./proof-scope";
import { guardsCalls, participatesInVerification, refinementFromType, sortFromType } from "./models";
import {
    addProof, assignedKeys, assignmentKey, assignmentOperators, arithmeticOperators, cloneState, comparisonOperators,
    diagnostic, innermostLoop, isBound, isIncrementOrDecrement, lexicalNames, safeIntegerRange, unsupported,
    initialState, writeValue, type Context, type JumpTarget, type State,
} from "./execution-state";
import { countTopLevelWrites, countWrites, mayCarryObligations, mayWriteValues, reportUnvisited } from "./coverage";
import { reportEncapsulation } from "./classes";
import { executeFor, executeWhile, loopInvariants } from "./loops";
import { conditionPaths, isStrictEquality, lowerEquality } from "./conditions";
import { resolveCallTarget, resolveFunction } from "./call-targets";
import type { ModeledFile, ProgramIndex } from "./program-index";
import {
    connectExecutor, instantiate, leaveObject, lowerMathCall, lowerMemberCall, lowerObjectCreation, lowerObjectExpression,
    returnFromMember, throwFromMember, verifyMember, writesField,
} from "./class-execution";

function lowerCall(node: TS.CallExpression, state: State, context: Context): Term | undefined {
    const invoked = immediatelyInvoked(node);
    if (invoked) return lowerImmediateCall(node, invoked, state, context, lowering);
    const math = lowerMathCall(node, state, context);
    if (math) return math;
    if (!ts.isIdentifier(node.expression)) {
        const target = resolveCallTarget(node, context);
        // A call the verifier cannot follow is reported here; coverage must not report it a second time.
        context.visited.add(node);
        if (!target) throw new Error("Only direct calls, and calls that resolve to one method of a class in a TS++ file, can participate in formal verification.");
        return lowerMemberCall(node, target, state, context);
    }
    context.visited.add(node);
    const functionName = nameText(node.expression);
    const model = resolveFunction(node, context);
    // A function declared in this file shadows a project-wide logic function of the same name.
    const logic = model ? undefined : context.logic.functions[functionName];
    if (logic) {
        const arguments_ = node.arguments.map(argument => lowerExpression(argument, state, context));
        if (arguments_.length !== logic.parameters.length) throw new Error(`'${functionName}' expects ${logic.parameters.length} arguments.`);
        logic.parameters.forEach((sort, index) => {
            if (arguments_[index].sort !== sort) throw new Error(`Argument ${index + 1} of '${functionName}' must be ${sort}.`);
        });
        return { smt: `(|${functionName}|${arguments_.length ? ` ${arguments_.map(argument => argument.smt).join(" ")}` : ""})`, sort: logic.result };
    }
    if (!model) throw new Error(`Call to unsupported function '${functionName}'.`);
    const argumentContext = context.currentFunction ? context : { ...context, currentFunction: model };
    const arguments_ = lowerCallArguments(node, model, state, argumentContext, lowering);
    for (const requirement of model.requires) {
        const goal = instantiate(requirement.value, model.parameters, arguments_, context.logic, undefined, model.numberModel);
        if (goal.sort !== "Bool") throw new Error(`The precondition of '${model.name}' is not Boolean.`);
        addProof(context, state, goal.smt, node, `${model.name} call precondition`);
    }
    for (const [parameter, refinement] of Object.entries(model.parameterRefinements ?? {})) {
        const index = model.parameters.indexOf(parameter);
        if (index < 0) continue;
        const goal = refinementTerm(refinement, arguments_[index], context.logic.functions);
        addProof(context, state, goal.smt, node.arguments[model.parameterPositions?.[index] ?? index], `${refinement.name} argument refinement`);
    }
    leaveObject(state, node, model.name, context);
    const sort = model.returnSort;
    const name = `tspp.call.${model.name}.${context.nextTemporary++}`;
    const result: Term | undefined = sort && { smt: `|${name}|`, sort };
    if (sort) state.declarations.add(`(declare-const |${name}| ${smtSort(sort)})`);
    if (model !== context.currentFunction) {
        for (const ensure of model.ensures) {
            if (!result && /\bresult\b/.test(ensure.value)) continue;
            const fact = instantiate(ensure.value, model.parameters, arguments_, context.logic, result, model.numberModel);
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
        if (model.returnRefinement && result) {
            const fact = refinementTerm(model.returnRefinement, result, context.logic.functions);
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
    }
    return result;
}

function lowerExpression(node: TS.Expression, state: State, context: Context): Term {
    if (ts.isParenthesizedExpression(node)) return lowerExpression(node.expression, state, context);
    if (ts.isIdentifier(node)) {
        if (nameText(node) === "true" || nameText(node) === "false") return { smt: nameText(node), sort: "Bool" };
        const value = state.values[nameText(node)];
        if (value) return value;
        const sort = state.variables[nameText(node)];
        if (!sort) throw new Error(`Unknown proof variable '${nameText(node)}'.`);
        return { smt: `|${nameText(node)}|`, sort };
    }
    const object = lowerObjectExpression(node, state, context);
    if (object) return object;
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
        const name = ts.isIdentifier(node.expression) && assignmentKey(node);
        if (name && state.values[name]) return state.values[name];
        if (name && state.variables[name]) return { smt: `|${name}|`, sort: state.variables[name] };
        if (nameText(node.name) === "length") {
            const receiver = lowerExpression(node.expression, state, context);
            return stringLengthTerm(receiver, context.currentFunction?.numberModel === "mathematical-real" ? "Real" : "NumberInt");
        }
        if (name) throw new Error(`Unknown proof field '${name}'.`);
    }
    if (ts.isBigIntLiteral(node)) return { smt: nameText(node).replace(/n$/, ""), sort: "Int" };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return stringTerm(nameText(node));
    }
    if (ts.isNumericLiteral(node)) {
        const model = context.currentFunction?.numberModel;
        if (context.currentFunction && !model) throw new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'.");
        if (model === "safe-integer" && !(/^\d+$/.test(nameText(node)) && Number(nameText(node)) <= Number.MAX_SAFE_INTEGER)) {
            throw new Error(`Numeric literal '${nameText(node)}' is not a safe integer.`);
        }
        const literal = nameText(node);
        const sort = model === "mathematical-real" || (!model && !Number.isSafeInteger(Number(literal))) ? "Real" : "NumberInt";
        return { smt: literal, sort };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        return { smt: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", sort: "Bool" };
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = lowerExpression(node.operand, state, context);
        if (node.operator === ts.SyntaxKind.ExclamationToken && operand.sort === "Bool") return { smt: `(not ${operand.smt})`, sort: "Bool" };
        if (node.operator === ts.SyntaxKind.MinusToken && isNumericSort(operand.sort)) return { smt: `(- ${operand.smt})`, sort: operand.sort };
        throw new Error("Unsupported unary proof expression.");
    }
    if (ts.isCallExpression(node)) {
        const result = lowerCall(node, state, context);
        if (!result) throw new Error("A call used as a proof value needs a modeled return type.");
        return result;
    }
    if (ts.isConditionalExpression(node)) return lowerConditional(node, state, context, lowering);
    if (ts.isElementAccessExpression(node)) {
        const field = lowerPositionalField(node, state);
        if (field) return field;
    }
    if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (isStrictEquality(operator)) return lowerEquality(node, state, context, lowerExpression);
        const left = lowerExpression(node.left, state, context);
        const right = lowerExpression(node.right, state, context);
        if (arithmeticOperators().has(operator) && left.sort === right.sort && isNumericSort(left.sort)) {
            return lowerArithmetic(operator, left, right, node, node.right, state, context);
        }
        if (comparisonOperators().has(operator) && isNumericSort(left.sort) && isNumericSort(right.sort)) {
            const smt = operator === ts.SyntaxKind.LessThanToken ? strictlyLessThan(left, right)
                : `(${comparisonOperators().get(operator)} ${left.smt} ${right.smt})`;
            return { smt, sort: "Bool" };
        }
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken && left.sort === "Bool" && right.sort === "Bool") return { smt: `(and ${left.smt} ${right.smt})`, sort: "Bool" };
        if (operator === ts.SyntaxKind.BarBarToken && left.sort === "Bool" && right.sort === "Bool") return { smt: `(or ${left.smt} ${right.smt})`, sort: "Bool" };
        throw new Error("Unsupported binary proof expression or incompatible sorts.");
    }
    throw new Error(node.pos < 0 ? "Unsupported proof expression." : `Unsupported proof expression '${context.sourceText.slice(nodeStart(node, context.sourceFile), node.end)}'.`);
}

function lowerArithmetic(
    operator: TS.SyntaxKind, left: Term, right: Term, node: TS.Node, rightNode: TS.Node, state: State, context: Context,
): Term {
    if (left.sort !== right.sort || !isNumericSort(left.sort)) throw new Error("Arithmetic operands must have the same numeric sort.");
    if (operator === ts.SyntaxKind.PercentToken && left.sort === "Real") throw new Error("Remainder requires the safe-integer model.");
    if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) {
        addProof(context, state, `(not (= ${right.smt} 0))`, rightNode, "division definedness");
    }
    if (operator === ts.SyntaxKind.SlashToken && left.sort === "Real") return { smt: `(/ ${left.smt} ${right.smt})`, sort: "Real" };
    const safeInteger = left.sort === "NumberInt";
    // JavaScript number division is exact, so the truncating integer model only matches when nothing is truncated.
    if (operator === ts.SyntaxKind.SlashToken && safeInteger) {
        addProof(context, state, `(= (tspp.js.trunc.rem ${left.smt} ${right.smt}) 0)`, node, "safe-integer exact division");
    }
    const result: Term = { smt: `(${arithmeticOperators().get(operator)} ${left.smt} ${right.smt})`, sort: left.sort };
    if (safeInteger && (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.AsteriskToken)) {
        addProof(context, state, safeIntegerRange(result.smt), node, "safe-integer range");
    }
    return result;
}

function writableKey(node: TS.Expression, state: State, context: Context): string | undefined {
    const key = assignmentKey(node);
    const receiver = key?.includes(".") ? key.slice(0, key.lastIndexOf(".")) : undefined;
    if (receiver && (state.values[receiver]?.sort ?? state.variables[receiver]) === "String") {
        throw new Error("String properties are read-only in verification.");
    }
    return key && writesField(key, context) ? key : undefined;
}

function updateAssignment(node: TS.BinaryExpression, state: State, context: Context): boolean {
    const key = writableKey(node.left, state, context);
    if (!key || !assignmentOperators().has(node.operatorToken.kind)) return false;
    const operator = assignmentOperators().get(node.operatorToken.kind);
    const right = lowerExpression(node.right, state, context);
    const value = operator === undefined ? right
        : lowerArithmetic(operator, lowerExpression(node.left, state, context), right, node, node.right, state, context);
    writeValue(state, key, value);
    return true;
}

function updateIncrement(node: TS.PrefixUnaryExpression | TS.PostfixUnaryExpression, state: State, context: Context): Term | undefined {
    const key = writableKey(node.operand, state, context);
    if (!key) return undefined;
    const current = lowerExpression(node.operand, state, context);
    const one: Term = { smt: current.sort === "Real" ? "1.0" : "1", sort: current.sort };
    const operator = node.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
    const next = lowerArithmetic(operator, current, one, node, node, state, context);
    writeValue(state, key, next);
    return ts.isPrefixUnaryExpression(node) ? next : current;
}

function executeStatement(node: TS.Statement, state: State, context: Context): State[] {
    try {
        if (ts.isBlock(node)) {
            const scoped = lexicalNames(node.statements).filter(name => !isBound(state, name));
            const after = executeStatements(node.statements, [state], context);
            for (const next of after) {
                for (const name of scoped) { delete next.values[name]; delete next.variables[name]; }
            }
            return after;
        }
        if (ts.isVariableStatement(node)) {
            const lexical = (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) return unsupported(state, declaration, context);
                const name = nameText(declaration.name);
                if (declaration.initializer && ts.isCallExpression(declaration.initializer)
                    && ts.isPropertyAccessExpression(declaration.initializer.expression)
                    && ["definePredicate", "defineFunction", "defineRecursiveFunction", "declareFunction"]
                        .includes(nameText(declaration.initializer.expression.name))) continue;
                // A shadowing binding would overwrite the outer value that later code still reads.
                if (lexical && isBound(state, name)) unsupported(state, declaration, context);
                // An object holds no value proofs read; its constructor still owes its preconditions.
                if (declaration.initializer && lowerObjectCreation(declaration.initializer, state, context)) {
                    if (isBound(state, name)) return unsupported(state, declaration, context);
                    delete state.values[name];
                    delete state.variables[name];
                    continue;
                }
                const refinement = refinementFromType(declaration.type, context.refinements);
                let value: Term | undefined;
                // A value outside the model is fine until something reads the name, which then reports it as unknown,
                // unless a refinement reads it now, or it hides an obligation or a write the verifier would then never see.
                try { value = declaration.initializer && lowerExpression(declaration.initializer, state, context); }
                catch (error) {
                    if (isBound(state, name) || refinement || mayCarryObligations(declaration.initializer!, state, context)
                        || mayWriteValues(declaration.initializer!)) throw error;
                }
                const sort = refinement?.sort
                    ?? sortFromType(declaration.type, context.refinements, context.currentFunction?.numberModel)
                    ?? value?.sort;
                if (value) writeValue(state, name, value);
                if (sort) state.variables[name] = sort;
                if (value && refinement) {
                    const goal = refinementTerm(refinement, value, context.logic.functions);
                    addProof(context, state, goal.smt, declaration.initializer ?? declaration, `${refinement.name} refinement introduction`);
                }
            }
            return [state];
        }
        if (ts.isLabeledStatement(node) && (nameText(node.label) === "assert" || nameText(node.label) === "assume")) {
            context.visited.add(node);
            if (!ts.isExpressionStatement(node.statement)) return unsupported(state, node, context);
            const condition = lowerExpression(node.statement.expression, state, context);
            if (condition.sort !== "Bool") throw new Error(`${nameText(node.label)} requires a Boolean expression.`);
            if (nameText(node.label) === "assert") addProof(context, state, condition.smt, node.statement.expression, "local assertion");
            state.facts.push(condition.smt);
            return [state];
        }
        if (ts.isExpressionStatement(node)) {
            let expression = node.expression;
            while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
            if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
                && nameText(expression.expression.name) === "axiom") return [state];
            if (lowerObjectCreation(expression, state, context)) return [state];
            if (ts.isCallExpression(expression) && !ts.isIdentifier(expression.expression) && !immediatelyInvoked(expression)) {
                const target = resolveCallTarget(expression, context);
                if (target) {
                    lowerMemberCall(expression, target, state, context);
                    return [state];
                }
            }
            if (ts.isBinaryExpression(expression) && assignmentOperators().has(expression.operatorToken.kind)) {
                return updateAssignment(expression, state, context) ? [state] : unsupported(state, node, context);
            }
            if (isIncrementOrDecrement(expression)) return updateIncrement(expression, state, context) ? [state] : unsupported(state, node, context);
            if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
                && (resolveFunction(expression, context) || context.logic.functions[nameText(expression.expression)])) {
                lowerCall(expression, state, context);
                return [state];
            }
            if (ts.isStringLiteral(expression)) return [state];
            // Unknown calls and other side effects may change anything the proof tracks.
            return unsupported(state, node, context);
        }
        if (ts.isReturnStatement(node) && context.inlineReturns) {
            context.visited.add(node);
            context.inlineReturns.push({ state, value: node.expression && lowerExpression(node.expression, state, context) });
            return [];
        }
        if (ts.isReturnStatement(node) && context.currentMember) return returnFromMember(node, state, context);
        if (ts.isReturnStatement(node)) {
            context.visited.add(node);
            if (!node.expression) {
                if (context.currentFunction?.ensures.length || context.currentFunction?.returnRefinement) {
                    throw new Error("A function with a postcondition must return a value.");
                }
                return [];
            }
            if (!context.currentFunction?.ensures.length && !context.currentFunction?.returnRefinement) {
                // Lowering still records the obligations of the returned expression (divisors, overflow). Only a
                // postcondition or return refinement reads the value itself, so a value outside the model is fine
                // unless it hides an obligation the verifier would then never check.
                let result: Term | undefined;
                try { result = lowerExpression(node.expression, state, context); }
                catch (error) { if (mayCarryObligations(node.expression, state, context)) throw error; }
                if (result && context.currentFunction?.returnSort) termForSort(result, context.currentFunction.returnSort, "Return value");
                return [];
            }
            const structured = lowerStructuredResult(node.expression, state, context, lowering);
            let result = structured ? undefined : lowerExpression(node.expression, state, context);
            if (result && context.currentFunction?.returnSort) result = termForSort(result, context.currentFunction.returnSort, "Return value");
            for (const ensure of context.currentFunction?.ensures ?? []) {
                const substitutions = { ...state.values, ...structured, ...(result ? { result } : {}) };
                const goal = expressionToSmtTerm(ensure.value, {
                    variables: state.variables, substitutions,
                    functions: context.logic.functions,
                    defaultNumberSort: context.currentFunction?.numberModel === "mathematical-real" ? "Real" : "NumberInt",
                });
                if (goal.sort !== "Bool") throw new Error("A postcondition must be Boolean.");
                addProof(context, state, goal.smt, node.expression, `${context.currentFunction?.name} postcondition`, ensure);
            }
            const refinement = context.currentFunction?.returnRefinement;
            if (refinement && result) {
                const goal = refinementTerm(refinement, result, context.logic.functions);
                addProof(context, state, goal.smt, node.expression, `${refinement.name} return refinement`);
            }
            return [];
        }
        if (ts.isThrowStatement(node)) return throwFromMember(node, state, context);
        if (ts.isIfStatement(node)) {
            const { truthy, falsy } = conditionPaths(node.expression, state, context, loopExecutor);
            const otherwise = node.elseStatement;
            return [
                ...truthy.flatMap(next => executeStatement(node.thenStatement, next, context)),
                ...(otherwise ? falsy.flatMap(next => executeStatement(otherwise, next, context)) : falsy),
            ];
        }
        if (ts.isSwitchStatement(node)) return executeSwitch(node, state, context);
        if (ts.isWhileStatement(node)) return executeWhile(node, state, context, loopExecutor);
        if (ts.isForStatement(node)) return executeFor(node, state, context, loopExecutor);
        if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
            const target = node.label ? undefined : ts.isBreakStatement(node)
                ? context.jumpTargets[context.jumpTargets.length - 1]
                : innermostLoop(context);
            if (!target) return unsupported(state, node, context);
            (ts.isBreakStatement(node) ? target.breaks : target.continues).push(state);
            return [];
        }
        if (ts.isEmptyStatement(node) || ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)
            || ts.isInterfaceDeclaration(node)) return [state];
        return unsupported(state, node, context);
    }
    catch (error) { diagnostic(context, node, error); return [state]; }
}

/** Follows JavaScript switch semantics: first matching case, fallthrough, and the no-match path. */
function executeSwitch(node: TS.SwitchStatement, state: State, context: Context): State[] {
    const discriminant = lowerExpression(node.expression, state, context);
    const clauses = node.caseBlock.clauses;
    const matches = clauses.map(clause => {
        if (!ts.isCaseClause(clause)) return undefined;
        const value = lowerExpression(clause.expression, state, context);
        if (value.sort !== discriminant.sort) throw new Error("A case value must have the same proof sort as the switch expression.");
        return `(= ${discriminant.smt} ${value.smt})`;
    });
    const misses = (until: number) => matches.slice(0, until).flatMap(match => match ? [`(not ${match})`] : []);
    const scoped = lexicalNames(clauses.flatMap(clause => clause.statements)).filter(name => !isBound(state, name));
    const target: JumpTarget = { kind: "switch", breaks: [], continues: [] };
    let falling: State[] = [];
    context.jumpTargets.push(target);
    try {
        clauses.forEach((clause, index) => {
            const entry = cloneState(state);
            const match = matches[index];
            entry.facts.push(...(match ? [...misses(index), match] : misses(clauses.length)));
            falling = executeStatements(clause.statements, [entry, ...falling], context);
        });
    }
    finally { context.jumpTargets.pop(); }
    const exits = [...falling, ...target.breaks];
    if (!matches.includes(undefined)) {
        const none = cloneState(state);
        none.facts.push(...misses(clauses.length));
        exits.push(none);
    }
    for (const next of exits) {
        for (const name of scoped) { delete next.values[name]; delete next.variables[name]; }
    }
    // Continues inside the switch belong to an enclosing loop.
    innermostLoop(context)?.continues.push(...target.continues);
    return exits;
}

function executeStatements(nodes: readonly TS.Statement[], states: State[], context: Context): State[] {
    for (const node of nodes) states = states.flatMap(state => executeStatement(node, state, context));
    return states;
}

const loopExecutor = { lowerExpression, executeStatement, updateIncrement };
const lowering: Lowering = { lowerExpression, executeStatements };
connectExecutor({ lowerExpression, executeStatements, owesProof });

/**
 * Whether a function without verification syntax of its own still owes a proof to that syntax: it calls a function with
 * a precondition or a refined parameter, binds a value of a refined type, or runs a loop with an invariant.
 */
function owesProof(statement: TS.FunctionLikeDeclaration, context: Context): boolean {
    const visit = (node: TS.Node): boolean => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const model = resolveFunction(node, context);
            if (model && guardsCalls(model)) return true;
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const target = resolveCallTarget(node, context);
            if (target && guardsCalls(target.member.model)) return true;
        }
        if (ts.isVariableDeclaration(node) && refinementFromType(node.type, context.refinements)) return true;
        if (ts.isWhileStatement(node) && loopInvariants(node, context).length) return true;
        return !!ts.forEachChild(node, child => visit(child) || undefined);
    };
    return !!statement.body && visit(statement.body);
}

export function collectProgramProofs(
    file: ModeledFile, index: ProgramIndex, diagnostics: TSPPAnalysisDiagnostic[], logic: LogicLibrary,
    nominalTypes: NominalTypesADTAPI | undefined,
): PendingProof[] {
    const { source, functions, classes, callTargets } = file;
    reportWithClauseIssues(source.fileName, source.text, diagnostics);
    const { sourceFile, refinements, records, constructors } = file.prepared;
    reportMisplacedRefinements(sourceFile, diagnostics);
    const proofs: PendingProof[] = [];
    const base: Omit<Context, "currentFunction"> = {
        fileName: source.fileName, sourceFile, sourceText: source.text, functions, classes, refinements, records, constructors, nominalTypes,
        callTargets, declarations: index.declarations, allClasses: [...index.files.values()].flatMap(other => [...other.classes.values()]),
        logic, proofs, diagnostics, visited: new Set(), jumpTargets: [], nextTemporary: 0,
    };
    const rejected = new Set<TS.Node>();
    for (const statement of sourceFile.statements) {
        // A syntax plugin's generated functions, such as data constructors, have no source to report on.
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || statement.body.pos < 0) continue;
        const model = functions.get(nameText(statement.name));
        if (!model) continue;
        const context: Context = { ...base, currentFunction: model };
        const usesNumber = statement.parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword)
            || statement.type?.kind === ts.SyntaxKind.NumberKeyword;
        // Ordinary number code is left alone; any proof obligation inside it is reported as unverified coverage.
        if (usesNumber && !model.numberModel && !participatesInVerification(statement, model)) continue;
        if (usesNumber && !model.numberModel) {
            diagnostic(context, statement.name, new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'."));
            rejected.add(statement);
            continue;
        }
        // Verification syntax decides what is verified. Any other function is not this plugin's, whatever it contains.
        if (!participatesInVerification(statement, model) && !owesProof(statement, context)) continue;
        executeStatements(statement.body.statements, [initialState(model, logic)], context);
        base.nextTemporary = context.nextTemporary;
    }
    for (const owner of classes.values()) {
        reportEncapsulation(owner, sourceFile, diagnostics);
        for (const member of owner.members) {
            const verified = verifyMember(owner, member, base, rejected);
            if (verified !== undefined) base.nextTemporary = verified;
        }
    }
    const topLevelState: State = { variables: {}, values: {}, declarations: new Set(logic.declarations), facts: [] };
    const proofVariables = collectTopLevelProofVariables(sourceFile, refinements);
    const writesProofVariable = (statement: TS.Statement) => ts.isExpressionStatement(statement)
        && [...assignedKeys(statement)].some(key => proofVariables.has(key.split(".")[0]));
    // Top-level writes run in source order; any other write (in a branch, loop, or function) makes the value unknown.
    const unstable = new Set([...proofVariables].filter(name => countWrites(sourceFile, name) > countTopLevelWrites(sourceFile, name)));
    for (const statement of sourceFile.statements) {
        const declaresProofVariable = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
            ts.isIdentifier(declaration.name) && proofVariables.has(nameText(declaration.name)));
        const isProofLabel = ts.isLabeledStatement(statement) && (nameText(statement.label) === "assert" || nameText(statement.label) === "assume");
        if (!declaresProofVariable && !isProofLabel && !writesProofVariable(statement)) continue;
        executeStatement(statement, topLevelState, base as Context);
        for (const name of unstable) {
            // A write we did not execute can change the type as well as the value.
            delete topLevelState.values[name];
            delete topLevelState.variables[name];
        }
    }
    const participants = new Set(sourceFile.statements.filter(ts.isFunctionDeclaration).flatMap(statement => {
        const model = statement.name && functions.get(nameText(statement.name));
        return model && participatesInVerification(statement, model) ? [model] : [];
    }));
    const calledFunction = (node: TS.Node) => ts.isCallExpression(node) ? resolveFunction(node, base as Context) : undefined;
    const visitCalls = (node: TS.Node): void => {
        if (ts.isFunctionLike(node)) return;
        const called = calledFunction(node);
        // Another file's function is checked here only for what its calls owe.
        if (called && ts.isCallExpression(node) && (participants.has(called) || guardsCalls(called))) {
            try { lowerCall(node, topLevelState, base as Context); } catch (error) { diagnostic(base as Context, node, error); }
        }
        else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !base.visited.has(node)) {
            const target = resolveCallTarget(node, base as Context);
            if (target && guardsCalls(target.member.model)) {
                try { lowerMemberCall(node, target, topLevelState, base as Context); } catch (error) { diagnostic(base as Context, node, error); }
            }
        }
        ts.forEachChild(node, visitCalls);
    };
    sourceFile.statements.forEach(visitCalls);
    reportUnvisited(sourceFile, base as Context, rejected);
    return proofs;
}
