// Collects the shipped capsules' skills into the versioned, installable skills/tspp tree.
// Usage: node scripts/build-skills.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { shippedPluginPackages } from "./plugin-entries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = "@tspp/plugin-";
const slash = value => value.split(path.sep).join("/");
const inside = (directory, target) => {
    const relative = path.relative(directory, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

/** Regular files only: following links would make the generated tree depend on files outside its sources. */
function filesBelow(directory) {
    if (!fs.existsSync(directory)) return [];
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error(`Expected a real directory: ${directory}`);
    }
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesBelow(full).map(file => `${entry.name}/${file}`);
        if (!entry.isFile()) throw new Error(`Skills must contain regular files, not links or special files: ${full}`);
        return [entry.name];
    });
}

/** Deliberately small authoring contract: unquoted single-line name and description, without YAML extensions. */
function skillMetadata(text, id) {
    const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1];
    const fields = new Map();
    for (const line of (header ?? "").split("\n").filter(line => line.trim())) {
        const field = /^(name|description): (\S.*)$/.exec(line);
        if (!field || fields.has(field[1])) throw new Error(`${id}/skills/SKILL.md needs exactly one plain name and description field.`);
        fields.set(field[1], field[2].trim());
    }
    const name = fields.get("name");
    const description = fields.get("description");
    if (name !== `tspp-${id}` || name.length > 64 || !description || description.length > 1024
        || /[\r\n|<>]/.test(description) || /:\s|\s#/.test(description)
        || /^["'>&*!{\[\]}#%@`?,:\-\d+\.]/.test(description)
        || /^(?:true|false|null|yes|no|on|off|~)$/i.test(description)) {
        throw new Error(`${id}/skills/SKILL.md needs name: tspp-${id} and a plain, single-line description (without YAML syntax or pipes).`);
    }
    return { name, description };
}

function rewriteDestination(destination, sourceFile, sourceDirectory, repositoryRoot, version) {
    const wrapped = destination.startsWith("<");
    const link = wrapped ? destination.slice(1, -1) : destination;
    if (/^(?:https?:|mailto:)/i.test(link) || link.startsWith("#")) return destination;
    if (/^(?:[a-z][\w+.-]*:|\/|\\)/i.test(link) || link.includes("\\")) {
        throw new Error(`Use relative or HTTPS links in ${sourceFile}: ${link}`);
    }
    const [, filename, suffix] = /^([^?#]*)(.*)$/.exec(link);
    const target = path.resolve(path.dirname(sourceFile), decodeURIComponent(filename));
    if (!inside(repositoryRoot, target) || !fs.existsSync(target)) {
        throw new Error(`Missing or out-of-repository skill reference in ${sourceFile}: ${link}`);
    }
    // Internal links survive the directory copy unchanged, including their anchors.
    if (inside(sourceDirectory, target)) return destination;
    const kind = fs.statSync(target).isDirectory() ? "tree" : "blob";
    const relative = slash(path.relative(repositoryRoot, target)).split("/").map(encodeURIComponent).join("/");
    const url = `https://github.com/tspp-lang/tspp/${kind}/v${version}/${relative}${suffix}`;
    return wrapped ? `<${url}>` : url;
}

/** Rewrites inline links/images and reference definitions, leaving fenced code examples alone. */
function rewriteMarkdown(text, sourceFile, sourceDirectory, repositoryRoot, version) {
    const rewrite = destination => rewriteDestination(destination, sourceFile, sourceDirectory, repositoryRoot, version);
    let fence;
    return text.split("\n").map(line => {
        const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
            return line;
        }
        if (fence) return line;
        return line
            .replace(/(!?\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?(\s*\))/g,
                (_, prefix, destination, title = "", end) => `${prefix}${rewrite(destination)}${title}${end}`)
            .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]+>|\S+)(.*)$/, (_, prefix, destination, rest) => `${prefix}${rewrite(destination)}${rest}`);
    }).join("\n");
}

/** Pure collection: validation completes before any output is changed. Parameters allow isolated fixture tests. */
export function skillFiles({ repositoryRoot = root, pluginPackages = shippedPluginPackages() } = {}) {
    const { version } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version ?? "")) throw new Error(`Invalid TS++ release version: ${version}`);
    const files = new Map();
    const index = ["| Plugin | When to read | Entry |", "| --- | --- | --- |"];
    for (const packageName of [...new Set(pluginPackages)].sort()) {
        if (!packageName.startsWith(scope)) throw new Error(`Not a feature package: ${packageName}`);
        const id = packageName.slice(scope.length);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid capsule id: ${id}`);
        const directory = path.join(repositoryRoot, "packages", "plugins", id, "skills");
        const entries = filesBelow(directory);
        if (!entries.includes("SKILL.md")) throw new Error(`Missing capsule skill: packages/plugins/${id}/skills/SKILL.md`);
        const entry = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
        const { description } = skillMetadata(entry, id);
        index.push(`| \`ts-plus-plus/plugins/${id}\` | ${description} | [${id}](references/${id}/SKILL.md) |`);
        for (const file of entries) {
            const source = path.join(directory, file);
            const content = file.endsWith(".md")
                ? Buffer.from(rewriteMarkdown(fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n"), source, directory, repositoryRoot, version))
                : fs.readFileSync(source);
            files.set(`references/${id}/${file}`, content);
        }
    }
    const template = fs.readFileSync(path.join(repositoryRoot, "scripts", "skills-entry.md"), "utf8").replace(/\r\n/g, "\n");
    if (template.split("{{version}}").length < 2 || template.split("{{features}}").length !== 2) throw new Error("Invalid skills entry template.");
    const entry = template.replaceAll("{{version}}", version).replace("{{features}}", index.join("\n"));
    if (/\{\{\w+\}\}/.test(entry)) throw new Error("Unresolved skills entry template variable.");
    files.set("SKILL.md", Buffer.from(entry));
    return files;
}

/** Checks are read-only; generation replaces changed files and removes obsolete generated files. */
export function syncSkills(files, output, { check = false } = {}) {
    const existing = filesBelow(output);
    const stale = existing.filter(file => !files.has(file));
    const changed = [...files].filter(([file, content]) => {
        const target = path.join(output, file);
        return !fs.existsSync(target) || !fs.statSync(target).isFile() || !fs.readFileSync(target).equals(content);
    }).map(([file]) => file);
    if (check || (!stale.length && !changed.length)) return { changed, stale };
    for (const file of stale) fs.unlinkSync(path.join(output, file));
    // Remove now-empty generated directories, including ones left by a removed capsule.
    function prune(directory) {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) prune(path.join(directory, entry.name));
        }
        if (directory !== output && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
    }
    prune(output);
    for (const file of changed) {
        const target = path.join(output, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, files.get(file));
    }
    return { changed, stale };
}

function main() {
    if (process.argv.slice(2).some(argument => argument !== "--check")) throw new Error("Usage: node scripts/build-skills.mjs [--check]");
    const check = process.argv.includes("--check");
    const { changed, stale } = syncSkills(skillFiles(), path.join(root, "skills", "tspp"), { check });
    if (check && (changed.length || stale.length)) {
        console.error(`skills/tspp is out of date (${[...changed, ...stale].join(", ")}). Run pnpm build:skills and commit skills/tspp.`);
        process.exitCode = 1;
    }
    else console.log(check ? "skills/tspp is up to date." : `skills/tspp: ${changed.length} written, ${stale.length} removed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
