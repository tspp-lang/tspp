import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { sourceFileOf } from "./nodes";
import type { MacroDeclarationSyntax, MacroKeywordType, MacroMembersSyntax, MacroPropertySyntax, MacroTarget, MacroTypeSyntax } from "./sdk";

/** Builds `MacroContext.describe`, which reads declarations as written and resolves only the names they reference. */
export function createDescriber(ts: TSPPTypeScript, checker: TS.TypeChecker) {
    const keywords = new Map<TS.SyntaxKind, MacroKeywordType>([
        [ts.SyntaxKind.AnyKeyword, "any"],
        [ts.SyntaxKind.BigIntKeyword, "bigint"],
        [ts.SyntaxKind.BooleanKeyword, "boolean"],
        [ts.SyntaxKind.NeverKeyword, "never"],
        [ts.SyntaxKind.NumberKeyword, "number"],
        [ts.SyntaxKind.ObjectKeyword, "object"],
        [ts.SyntaxKind.StringKeyword, "string"],
        [ts.SyntaxKind.SymbolKeyword, "symbol"],
        [ts.SyntaxKind.UndefinedKeyword, "undefined"],
        [ts.SyntaxKind.UnknownKeyword, "unknown"],
        [ts.SyntaxKind.VoidKeyword, "void"],
    ]);

    const textOf = (node: TS.Node) => node.getText(sourceFileOf(ts, node));
    const named = (node: TS.InterfaceDeclaration | TS.TypeAliasDeclaration | TS.ClassDeclaration, name: TS.Identifier) => ({
        name: ts.idText(name),
        typeParameters: (node.typeParameters ?? []).map(parameter => ts.idText(parameter.name)),
        exported: !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
    });

    function entityText(name: TS.EntityName): string {
        return ts.isIdentifier(name) ? ts.idText(name) : `${entityText(name.left)}.${ts.idText(name.right)}`;
    }

    function resolve(location: TS.EntityName | TS.Expression, name: string): MacroTarget | undefined {
        let symbol = checker.getSymbolAtLocation(location);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declarations = symbol?.declarations ?? [];
        const node = declarations[0];
        if (!symbol || !node) return undefined;
        return { name, symbol, node, declarations, sourceFile: sourceFileOf(ts, node) };
    }

    function literal(node: TS.LiteralTypeNode): MacroTypeSyntax {
        const text = textOf(node);
        const value = node.literal;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { kind: "literal", value: value.text, text };
        if (ts.isNumericLiteral(value)) return { kind: "literal", value: Number(value.text), text };
        if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) {
            return { kind: "literal", value: -Number(value.operand.text), text };
        }
        if (value.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true, text };
        if (value.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false, text };
        if (value.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null, text };
        return { kind: "unsupported", text };
    }

    function type(node: TS.TypeNode): MacroTypeSyntax {
        while (ts.isParenthesizedTypeNode(node)) node = node.type;
        const text = textOf(node);
        const keyword = keywords.get(node.kind);
        if (keyword) return { kind: "keyword", keyword, text };
        if (ts.isLiteralTypeNode(node)) return literal(node);
        if (ts.isTypeReferenceNode(node)) {
            return { kind: "reference", name: entityText(node.typeName), arguments: (node.typeArguments ?? []).map(type), target: resolve(node.typeName, entityText(node.typeName)), text };
        }
        if (ts.isArrayTypeNode(node)) return { kind: "array", element: type(node.elementType), readonly: false, text };
        if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isArrayTypeNode(node.type)) {
            return { kind: "array", element: type(node.type.elementType), readonly: true, text };
        }
        if (ts.isUnionTypeNode(node)) return { kind: "union", types: node.types.map(type), text };
        if (ts.isTypeLiteralNode(node)) return { kind: "object", text, ...members(node.members) };
        return { kind: "unsupported", text };
    }

    /** A base in `extends`, which is a reference when it names an entity. */
    function base(node: TS.ExpressionWithTypeArguments): MacroTypeSyntax {
        const text = textOf(node);
        const name = expressionName(node.expression);
        if (name === undefined) return { kind: "unsupported", text };
        return { kind: "reference", name, arguments: (node.typeArguments ?? []).map(type), target: resolve(node.expression, name), text };
    }

    function expressionName(expression: TS.Expression): string | undefined {
        if (ts.isIdentifier(expression)) return ts.idText(expression);
        if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)) return undefined;
        const left = expressionName(expression.expression);
        return left === undefined ? undefined : `${left}.${ts.idText(expression.name)}`;
    }

    function propertyName(name: TS.PropertyName): string | undefined {
        if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return ts.idText(name);
        if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
        return undefined;
    }

    function documentation(node: TS.Node): string | undefined {
        const comments = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
        const text = comments.map(comment => ts.getTextOfJSDocComment(comment.comment) ?? "").filter(Boolean).join("\n");
        return text || undefined;
    }

    function members(elements: readonly TS.TypeElement[]): MacroMembersSyntax {
        const properties: MacroPropertySyntax[] = [];
        const unsupportedMembers: string[] = [];
        for (const element of elements) {
            const name = ts.isPropertySignature(element) ? propertyName(element.name) : undefined;
            if (!ts.isPropertySignature(element) || !element.type || name === undefined) {
                unsupportedMembers.push(textOf(element));
                continue;
            }
            properties.push({
                name,
                optional: !!element.questionToken,
                readonly: !!element.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
                type: type(element.type),
                documentation: documentation(element),
            });
        }
        return { members: properties, unsupportedMembers };
    }

    return function describe(declaration: TS.Node): MacroDeclarationSyntax | undefined {
        if (ts.isInterfaceDeclaration(declaration)) {
            const heritage = (declaration.heritageClauses ?? []).flatMap(clause => clause.types.map(base));
            return { kind: "interface", ...named(declaration, declaration.name), heritage, ...members(declaration.members) };
        }
        if (ts.isTypeAliasDeclaration(declaration)) {
            return { kind: "type-alias", ...named(declaration, declaration.name), type: type(declaration.type) };
        }
        if (ts.isClassDeclaration(declaration) && declaration.name) {
            return { kind: "class", ...named(declaration, declaration.name) };
        }
        return undefined;
    };
}
