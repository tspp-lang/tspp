import type { TSPPPluginDisposer } from "@tspp/plugin-sdk";
import type {
    TSPPCompilerPluginAPI,
    TSPPKindAnnotationParser,
    TSPPKindAnnotationSyntax,
    TSPPPostfixTypeSyntax,
    TSPPTypeKind,
    TSPPTypeSyntax,
} from "@tspp/plugin-sdk/compiler";

export function parseKind(parser: TSPPKindAnnotationParser): TSPPTypeKind {
    const kinds = parser.kinds;
    let head: TSPPTypeKind;
    if (parser.token() === kinds.openParenToken) {
        parser.nextToken();
        const parameters: TSPPTypeKind[] = [];
        while (parser.token() !== kinds.closeParenToken && parser.token() !== kinds.endOfFileToken) {
            parameters.push(parseKind(parser));
            if (parser.token() !== kinds.commaToken) break;
            parser.nextToken();
        }
        parser.parseExpected(kinds.closeParenToken);
        if (parser.token() !== kinds.equalsGreaterThanToken) {
            if (parameters.length === 1) return parameters[0];
            throw new Error("A parenthesized kind list must be followed by '=>'.");
        }
        parser.nextToken();
        return { kind: "function", parameters, result: parseKind(parser) };
    }

    const match = /^Type(0|[1-9]\d*)?$/u.exec(parser.tokenText());
    if (parser.token() !== kinds.identifier || !match) {
        throw new Error(`Expected a type kind, received '${parser.tokenText()}'.`);
    }
    parser.nextToken();
    head = { kind: "type", level: match[1] === undefined ? 0 : Number(match[1]) };
    if (parser.token() === kinds.equalsGreaterThanToken) {
        parser.nextToken();
        head = { kind: "function", parameters: [head], result: parseKind(parser) };
    }
    return head;
}

/** Kind annotations (`F: Type => Type`), universes (`Type1`), and applications of type parameters (`F<A>`). */
export function registerHigherKindedTypes(compiler: TSPPCompilerPluginAPI): TSPPPluginDisposer {
    const kinds = compiler.typeSyntaxKinds;
    const kindSyntax: TSPPKindAnnotationSyntax = {
        startTokens: [kinds.colonToken],
        isStart: parser => parser.token() === kinds.colonToken,
        parse: parser => {
            parser.parseExpected(kinds.colonToken);
            return parseKind(parser);
        },
    };
    const universeSyntax: TSPPTypeSyntax = {
        startTokens: [kinds.identifier],
        preserveDeclarationText: true,
        isStart: parser => parser.token() === kinds.identifier && /^Type(?:0|[1-9]\d*)?$/u.test(parser.tokenText()),
        parse: parser => {
            const pos = parser.getNodePos();
            const match = /^Type(0|[1-9]\d*)?$/u.exec(parser.tokenText());
            const level = match?.[1] === undefined ? 0 : Number(match[1]);
            parser.nextToken();
            return parser.finishTypeUniverse(level, pos);
        },
    };
    const applicationSyntax: TSPPPostfixTypeSyntax = {
        startTokens: [kinds.lessThanToken],
        isStart: parser => parser.token() === kinds.lessThanToken,
        parse: (target, parser) => {
            const pos = parser.getNodePos();
            const typeArguments = parser.parseTypeArguments() ?? [];
            return parser.finishTypeApplication(target, typeArguments, pos);
        },
    };
    const disposeKind = compiler.registerKindAnnotationSyntax(kindSyntax);
    const disposeUniverse = compiler.registerTypeSyntax(universeSyntax);
    const disposeApplication = compiler.registerPostfixTypeSyntax(applicationSyntax);
    return () => {
        disposeApplication();
        disposeUniverse();
        disposeKind();
    };
}

/** Hover text for a universe such as `Type1`. */
export function universeQuickInfo(token: { readonly text: string; readonly start: number; readonly length: number; }) {
    const universe = /^Type(\d*)$/.exec(token.text);
    if (!universe) return undefined;
    const level = universe[1] ? Number(universe[1]) : 0;
    return {
        start: token.start,
        length: token.length,
        display: `type Type${level}: Type${level + 1}`,
        documentation: `The universe whose inhabitants have level ${level}.`,
    };
}

export function kindParameterOwner(sourceText: string, position: number, name: string): string | undefined {
    const expression = /\btype\s+([A-Za-z_$][\w$]*)\s*<([^;>{}]*)>\s*(?::\s*([^=]+))?=/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(sourceText))) {
        if (position < match.index || position > expression.lastIndex) continue;
        const parameter = match[2].split(",").map(value => value.trim())
            .find(value => value.split(/\s*:/)[0] === name);
        if (!parameter) continue;
        const resultKind = match[3]?.trim();
        return `type ${match[1]}<${match[2].trim()}>${resultKind ? `: ${resultKind}` : ""}`;
    }
    return undefined;
}
