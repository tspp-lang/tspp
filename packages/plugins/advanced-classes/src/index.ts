import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createAdvancedClassDeclarations } from "./class-decl";
import { createAdvancedClassDiagnostics } from "./diagnostics";
import { createFieldSyntax, findEnclosingAccessorName } from "./field";
import { createObjectSyntax } from "./object";
import { createWithSyntax } from "./with";

const pluginId = "advanced-classes";

const keywordDocs: Readonly<Record<string, string>> = {
    object: "Declares a first-class singleton instance and its corresponding type.",
    final: "Marks a class as non-inheritable or a method as non-overridable.",
    sealed: "Restricts subclasses to the same declaring source file.",
    data: "Declares a data class with auto-synthesized constructor, copy, equals, and toString.",
    field: "Declares a property with implicit backing storage or references it inside accessors.",
    with: "Creates a non-destructive copy of an object with updated properties.",
};

const keywordKinds: Readonly<Record<string, string>> = {
    object: "declaration",
    final: "modifier",
    sealed: "modifier",
    data: "modifier",
    with: "expression",
    field: "modifier",
};

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, match => " ".repeat(match.length));
}

interface ParsedClass {
    name: string;
    isFinal: boolean;
    isSealed: boolean;
    isData: boolean;
    isAbstract: boolean;
    primaryParams?: string;
    members: Map<string, { kind: "property" | "method"; type?: string; params?: string; returnType?: string; modifiers?: string }>;
}

interface ParsedObject {
    name: string;
    members: Map<string, { kind: "property" | "method"; type?: string; params?: string; returnType?: string; modifiers?: string }>;
}

function parseAdvancedClassesFromSource(sourceText: string): { classes: Map<string, ParsedClass>; objects: Map<string, ParsedObject> } {
    const clean = stripComments(sourceText);
    const classes = new Map<string, ParsedClass>();
    const objects = new Map<string, ParsedObject>();

    // Parse classes
    const classRegex = /(?:(export\s+)?(default\s+)?)?((?:[a-z]+\s+)*)class\s+([A-Za-z_$][\w$]*)(?:<[^>]*>)?(?:\s*\(([^)]*)\))?/g;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(clean)) !== null) {
        const rawMods = match[3] ? match[3].split(/\s+/).filter(Boolean) : [];
        const className = match[4];
        const primaryParams = match[5];
        const cls: ParsedClass = {
            name: className,
            isFinal: rawMods.includes("final"),
            isSealed: rawMods.includes("sealed"),
            isData: rawMods.includes("data") || Boolean(primaryParams !== undefined),
            isAbstract: rawMods.includes("abstract"),
            primaryParams,
            members: new Map(),
        };
        if (cls.isData && primaryParams) {
            const params = primaryParams.split(",").map(p => p.trim()).filter(Boolean);
            for (const param of params) {
                const parts = param.replace(/^(?:val|var|readonly)\s+/, "").split(":");
                const pName = parts[0]?.trim();
                const pType = parts[1]?.trim() || "any";
                if (pName) {
                    cls.members.set(pName, { kind: "property", type: pType });
                }
            }
            cls.members.set("copy", { kind: "method", params: `patch?: { ${primaryParams} }`, returnType: className });
            cls.members.set("equals", { kind: "method", params: "other: unknown", returnType: "boolean" });
            cls.members.set("toString", { kind: "method", params: "", returnType: "string" });
        }
        classes.set(className, cls);
    }

    // Parse objects
    const objRegex = /(?:(export\s+)?(default\s+)?)?object\s+([A-Za-z_$][\w$]*)/g;
    while ((match = objRegex.exec(clean)) !== null) {
        const objName = match[3];
        objects.set(objName, {
            name: objName,
            members: new Map(),
        });
    }

    // Parse members inside braces
    const declBlockRegex = /(?:[a-z]+\s+)*(?:class|object)\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
    while ((match = declBlockRegex.exec(clean)) !== null) {
        const declName = match[1];
        const openBrace = declBlockRegex.lastIndex - 1;
        let depth = 1;
        let i = openBrace + 1;
        while (depth > 0 && i < clean.length) {
            if (clean[i] === "{") depth++;
            else if (clean[i] === "}") depth--;
            i++;
        }
        const body = clean.slice(openBrace + 1, i - 1);
        const target = classes.get(declName) || objects.get(declName);
        if (!target) continue;

        // Field properties: field name: type
        const fieldRegex = /\bfield\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^={;]+))?/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldRegex.exec(body)) !== null) {
            target.members.set(fm[1], { kind: "property", type: fm[2]?.trim() || "any" });
        }

        // Regular properties: name: type
        const propRegex = /(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+)*([A-Za-z_$][\w$]*)\s*:\s*([^=;{]+)\s*(?:=[^;{]*)?[;]/g;
        let pm: RegExpExecArray | null;
        while ((pm = propRegex.exec(body)) !== null) {
            if (pm[1] !== "field" && pm[1] !== "return") {
                target.members.set(pm[1], { kind: "property", type: pm[2]?.trim() });
            }
        }

        // Methods: [modifiers] name(params): returnType
        const methodRegex = /((?:(?:public|private|protected|static|abstract|final|override|async)\s+)*)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?\s*[{;]/g;
        let mm: RegExpExecArray | null;
        while ((mm = methodRegex.exec(body)) !== null) {
            if (!["constructor", "get", "set", "if", "while", "for", "switch"].includes(mm[2])) {
                target.members.set(mm[2], {
                    kind: "method",
                    modifiers: mm[1]?.trim() || undefined,
                    params: mm[3]?.trim() || "",
                    returnType: mm[4]?.trim() || "void",
                });
            }
        }
    }

    return { classes, objects };
}

export const advancedClassesPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Advanced classes",
        syntax: {
            keywords: [
                { keyword: "object", position: "declaration" },
                { keyword: "final", position: "declaration" },
                { keyword: "sealed", position: "declaration" },
                { keyword: "field", position: "primary-expression" },
                { keyword: "with", position: "expression" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const ts = context.ts;
                const objects = createObjectSyntax(ts);
                const classDecls = createAdvancedClassDeclarations(ts);
                const fieldSyntax = createFieldSyntax(ts);
                const withSyntax = createWithSyntax(ts);

                context.onDispose(context.compiler.registerSyntaxExtension(objects.extension));
                context.onDispose(context.compiler.registerSyntaxExtension(classDecls.extension));
                context.onDispose(context.compiler.registerSyntaxExtension(fieldSyntax.extension));
                context.onDispose(context.compiler.registerSyntaxExtension(withSyntax.extension));

                const diagnostics = createAdvancedClassDiagnostics(ts, classDecls, fieldSyntax, withSyntax);
                return context.compiler.registerDiagnosticProvider(diagnostics);
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    const generatedConstructor = /^constructor ([A-Za-z_$][\w$]*)\.__constructor$/.exec(request.upstream?.display ?? "");
                    if (generatedConstructor) return { start: token.start, length: token.length, display: `class ${generatedConstructor[1]}` };

                    // 1. Hover on 'field' keyword or backing variable
                    if (token.text === "field") {
                        const accessor = findEnclosingAccessorName(request.sourceText, token.start);
                        if (accessor) {
                            let propType: string | undefined;
                            const escaped = accessor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                            const match = new RegExp(`\\bfield\\s+${escaped}\\s*:\\s*([^={;]+)`).exec(request.sourceText);
                            if (match) propType = match[1].trim();
                            if (!propType && request.semanticType && request.semanticType !== "any") {
                                propType = request.semanticType;
                            }
                            return {
                                start: token.start,
                                length: token.length,
                                display: `(TS++ backing storage) field${propType ? `: ${propType}` : ""}`,
                                documentation: `Implicit backing storage property for '${accessor}'.`,
                            };
                        }
                        return {
                            start: token.start,
                            length: token.length,
                            display: "(TS++ keyword) field",
                            documentation: keywordDocs.field,
                        };
                    }

                    // 1.5. Hover on parameter of set accessor inside field property: set(v)
                    const cleanText = stripComments(request.sourceText);
                    if (/^[A-Za-z_$][\w$]*$/.test(token.text) && cleanText.includes("field") && cleanText.includes("set")) {
                        const escapedToken = token.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        const setParamRegex = new RegExp(String.raw`\bfield\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^={;]+))?[^{]*\{[\s\S]*?\bset\s*\(\s*${escapedToken}\s*(?::\s*([^)]+))?\s*\)`, "g");
                        let spMatch: RegExpExecArray | null;
                        while ((spMatch = setParamRegex.exec(cleanText)) !== null) {
                            const setIndex = spMatch[0].lastIndexOf("set");
                            const fullSetStart = spMatch.index + setIndex;
                            let depth = 0;
                            let bodyEnd = -1;
                            for (let j = fullSetStart; j < cleanText.length; j++) {
                                if (cleanText[j] === "{") depth++;
                                else if (cleanText[j] === "}") {
                                    depth--;
                                    if (depth === 0) {
                                        bodyEnd = j;
                                        break;
                                    }
                                }
                            }
                            if (token.start >= fullSetStart && (bodyEnd === -1 || token.start <= bodyEnd)) {
                                const fieldType = spMatch[3]?.trim() || spMatch[2]?.trim() || "any";
                                return {
                                    start: token.start,
                                    length: token.length,
                                    display: `(parameter) ${token.text}: ${fieldType}`,
                                };
                            }
                        }
                    }

                    // 2. Hover on other TS++ keywords: object, final, sealed, data, with
                    if (keywordDocs[token.text]) {
                        if (token.text === "data") {
                            const afterToken = request.sourceText.slice(token.start);
                            if (!/^\bdata\s+class\b/.test(afterToken)) return undefined;
                        }
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: keywordDocs[token.text],
                        };
                    }

                    if (!cleanText.includes("class") && !cleanText.includes("object")) {
                        return undefined;
                    }

                    const { classes, objects } = parseAdvancedClassesFromSource(request.sourceText);

                    // 3. Hover on class declaration or class name reference
                    const cls = classes.get(token.text);
                    if (cls) {
                        let prefix = "";
                        if (cls.isFinal) prefix = "final ";
                        else if (cls.isSealed && cls.isAbstract) prefix = "sealed abstract ";
                        else if (cls.isSealed) prefix = "sealed ";
                        else if (cls.isData) prefix = "data ";
                        else if (cls.isAbstract) prefix = "abstract ";

                        let display = `${prefix}class ${cls.name}`;
                        if (cls.isData && cls.primaryParams) {
                            display = `data class ${cls.name}(${cls.primaryParams.trim()})`;
                        }
                        return {
                            start: token.start,
                            length: token.length,
                            display,
                            documentation: undefined,
                        };
                    }

                    // 4. Hover on object singleton declaration or reference
                    const obj = objects.get(token.text);
                    if (obj) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `object ${obj.name}`,
                            documentation: undefined,
                        };
                    }

                    // 5. Hover on member properties or methods of TS++ classes / objects
                    // Check enclosing class or object first
                    for (const [clsName, c] of classes) {
                        const member = c.members.get(token.text);
                        if (member) {
                            if (member.kind === "method") {
                                const modPrefix = member.modifiers ? member.modifiers + " " : "";
                                return {
                                    start: token.start,
                                    length: token.length,
                                    display: `(method) ${modPrefix}${clsName}.${token.text}(${member.params ?? ""}): ${member.returnType ?? "void"}`,
                                };
                            } else {
                                return {
                                    start: token.start,
                                    length: token.length,
                                    display: `(property) ${clsName}.${token.text}: ${member.type ?? "any"}`,
                                };
                            }
                        }
                    }

                    for (const [objName, o] of objects) {
                        const member = o.members.get(token.text);
                        if (member) {
                            if (member.kind === "method") {
                                const modPrefix = member.modifiers ? member.modifiers + " " : "";
                                return {
                                    start: token.start,
                                    length: token.length,
                                    display: `(method) ${modPrefix}${objName}.${token.text}(${member.params ?? ""}): ${member.returnType ?? "void"}`,
                                };
                            } else {
                                return {
                                    start: token.start,
                                    length: token.length,
                                    display: `(property) ${objName}.${token.text}: ${member.type ?? "any"}`,
                                };
                            }
                        }
                    }

                    return undefined;
                });
            },
        },
        editor: {
            keywords: ["object", "final", "sealed", "field", "with", "data"],
            grammars: ["./editor/advanced-classes.tmLanguage.json"],
        },
    },
});

export default advancedClassesPlugin;
