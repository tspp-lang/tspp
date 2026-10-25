/**
 * tspp playground boot: wires the vendored official sandbox + playground UI (MIT,
 * from microsoft/TypeScript-Website) to the tspp compiler bundle and the TsppWorker.
 */
import "./vendor/site.css"
import "./vendor/playground.css"
import "./style.css"

// editor.main = editor.api + ALL editor contributions (hover, suggest, go-to-definition,
// find, ...). The official playground loads "vs/editor/editor.main"; importing plain
// editor.api yields an editor without those features, and the sandbox's own lazy
// imports of the contributions happen only after the editor was already created.
import * as monaco from "monaco-editor/editor/editor.main.js"

// ---- compiler module selection -------------------------------------------------------------------------------
// The compiler bundle is NOT bundled into the app: it is fetched at runtime (like the
// official playground loads its typescript.js) so the main thread and the worker share
// one compiler instance, and so ?ts=dev can swap in a locally built compiler.
//   default       vendor/typescript.js (public/vendor/, git-ignored, regenerated from the
//                 compiler sources by `pnpm generate` before every `pnpm dev` / `pnpm build`)
//   ?ts=dev       typescript.dev.js (public/typescript.dev.js, git-ignored; rebuild it
//                 with `pnpm bundle:dev` after editing the compiler, then reload)
// This must run before MonacoEnvironment is installed: getWorker's closure below hands
// the URL to each tspp worker. Resolved to an absolute URL because the worker would
// otherwise resolve a relative specifier against its own chunk's location (assets/).
const params = new URLSearchParams(location.search)
const useDevCompiler = params.get("ts") === "dev"
const compilerUrl = new URL(
  useDevCompiler ? "typescript.dev.js" : "vendor/typescript.js",
  document.baseURI,
).href

// Take over ALL worker spawns: monaco's worker factories consult
// MonacoEnvironment.getWorker before their internal descriptors, whose npm-internal
// worker entries vite 0.57 does not bundle cleanly (relative imports leak into the
// emitted chunk and blob-URL loading then fails). Both entries below are first-party
// and fully bundled.
;(globalThis as unknown as { MonacoEnvironment: import("monaco-editor").Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      const worker = new Worker(new URL("./worker/tspp.worker.js", import.meta.url), { type: "module" })
      // Worker globals are separate from the main thread's — globalThis is invisible
      // inside the worker — so the compiler URL travels as the worker's first message;
      // the entry pulls it out of its early-message buffer.
      worker.postMessage({ tsppCompilerUrl: compilerUrl })
      return worker
    }
    return new Worker(new URL("./editorWebWorker.js", import.meta.url), { type: "module" })
  },
}
// Register the "typescript" language id (monaco 0.57 moved basic-language
// registrations under esm/vs/languages/definitions/<lang>/register.js).
import "monaco-editor/languages/definitions/typescript/register.js"
// The TypeScript language-mode contribution (monaco 0.57): importing it registers the
// onLanguage hooks; its namespace (defaults/ModuleKind/getTypeScriptWorker...) must be
// attached to monaco.languages manually in ESM — nothing in the ESM tree does it.
import * as typescriptNamespace from "monaco-editor/language/typescript/monaco.contribution.js"
;(monaco.languages as unknown as Record<string, unknown>).typescript = typescriptNamespace

// ---- compiler module loading -------------------------------------------------------------------------------
// Worker imports go through an object URL too: the fetched text is compiled once
// under this origin, so the worker needs no CORS clearance for the compiler host.
// (The blob's own internal imports, if any, would break — the bundle is fully
// self-contained by construction, enforced by scripts/build-bundle.mjs externals.)
// The global is a secondary channel for the main-thread fallback path only.
;(globalThis as unknown as { TSPP_COMPILER_URL: string }).TSPP_COMPILER_URL = compilerUrl
type TsppModule = typeof import("../public/vendor/typescript.js")
// Fetch + object-URL import rather than `import(compilerUrl)` directly: vite's
// __vitePreload wraps dynamic imports and re-bases relative URLs against the
// importing chunk's location (assets/), which would 404. An object URL is also
// same-origin, so the compiler stays importable from the worker without CORS
// gymnastics (and the same trick is ready for a future z3-solver WASM module).
async function importFromUrl(url: string): Promise<TsppModule> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  // compute the object URL in its own statement: vite's __vitePreload transform
  // cannot hoist an `await` that sits inside a dynamic import's argument
  const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }))
  return import(/* @vite-ignore */ blobUrl) as Promise<TsppModule>
}
let tspp: TsppModule
try {
  tspp = await importFromUrl(compilerUrl)
} catch (err) {
  const hint = useDevCompiler
    ? "Run `pnpm bundle:dev` in the playground package first (it writes public/typescript.dev.js), then reload."
    : "The deployed compiler bundle could not be fetched — check the network or the deployment."
  const msg = `Failed to load the tspp compiler from ${compilerUrl}. ${hint}`
  ;(document.getElementById("loading-message") ?? document.body).textContent = msg
  console.error(msg, err)
  throw err
}
console.info(`[tspp] compiler: ${compilerUrl} (tspp ${tspp.version})`)

import { tsppLanguage } from "./tsppLanguage"
import { playCopy } from "./vendor/playgroundCopy"
import { createTypeScriptSandbox } from "./vendor/sandbox"
import { setupPlayground, type PlaygroundPlugin, type PluginFactory } from "./vendor/playground"
import { getPlaygroundPlugins } from "./vendor/playground/sidebar/settings"
import { getExampleSourceCode } from "./vendor/playground/getExample"
import { examples } from "./examples"

// The feature list is NOT mirrored by hand: the compiler bundle exports its own
// tsppFeatureDefinitions (the public API re-exports src/compiler/tsppFeatures.ts), and
// the bundle is rebuilt from compiler main on every deploy — so the panel always
// matches the deployed compiler. initComments carries the feature's Chinese summary.
const tsppFeatureDefinitions = tspp.tsppFeatureDefinitions
if (!tsppFeatureDefinitions?.length) {
  throw new Error("Compiler bundle exports no tsppFeatureDefinitions — rebuild the bundle (`pnpm bundle`)")
}

// Extend the built-in TypeScript grammar with tspp keywords (data/newtype/match/reify/...)
monaco.languages.setMonarchTokensProvider("typescript", tsppLanguage as unknown as monaco.languages.MonarchLanguage)

// minimal i18n: official English copy with key fallback
const i = (key: string, _components?: unknown) => (playCopy as Record<string, string>)[key] ?? key

// The official site injects localized compiler-option summaries as a global which the
// vendored createConfigDropdown reads as a bare identifier. Synthesize them from the
// compiler bundle's own optionDeclarations (the dropdown also has a per-option fallback,
// but the target/jsx/module selects require the entries to exist).
;(globalThis as unknown as Record<string, unknown>).optionsSummary = (
  tspp.optionDeclarations as unknown as any[]
).map(option => ({
  id: option.name,
  display: option.name,
  oneliner: option.description?.message ?? "",
  categoryID: option.category?.key ?? "Other_Options",
  categoryDisplay: option.category?.message ?? "Other Options",
}))

// ---- tspp feature state --------------------------------------------------------------------
export const defaultFeatures = [
  "higherKindedTypes",
  "nominalTypes",
  
  "typeUniverses",
]

const rawStored = localStorage.getItem("tsppFeatures")
const initialStored = (() => {
  if (!rawStored) return defaultFeatures
  try {
    const parsed = JSON.parse(rawStored)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
    return defaultFeatures
  } catch {
    return defaultFeatures
  }
})()

const enabledFeatures = new Set<string>(initialStored)
localStorage.setItem("tsppFeatures", JSON.stringify([...enabledFeatures]))

function expandDependencies(names: Iterable<string>): string[] {
  const out = new Set<string>()
  const add = (name: string) => {
    if (out.has(name)) return
    out.add(name)
    const def = tsppFeatureDefinitions.find(d => d.name === name)
    def?.dependencies.forEach(add)
  }
  for (const name of names) add(name)
  return [...out]
}

// The features actually in effect (user selection + dependency closure), plus who
// pulled each implicit feature in — used to render checkbox states honestly.
function featureEffectState() {
  const expanded = new Set<string>()
  const implicitBy = new Map<string, string[]>()
  const visit = (name: string, root: string) => {
    if (!enabledFeatures.has(name)) {
      const list = implicitBy.get(name) ?? []
      if (!list.includes(root)) list.push(root)
      implicitBy.set(name, list)
    }
    if (expanded.has(name)) return
    expanded.add(name)
    const def = tsppFeatureDefinitions.find(d => d.name === name)
    for (const dep of def?.dependencies ?? []) visit(dep, root)
  }
  for (const name of enabledFeatures) visit(name, name)
  return { expanded, implicitBy }
}

// Persist + push to the compiler + refresh the sidebar checkboxes.
function applyFeatures() {
  localStorage.setItem("tsppFeatures", JSON.stringify([...enabledFeatures]))
  sandboxForFeatures?.updateCompilerSetting("tsppFeatures", expandDependencies(enabledFeatures))
  refreshFeatureChecks()
}

// Set as soon as the sandbox exists (not when the features plugin mounts: plugins
// mount lazily when their tab is first opened, and the examples loader must reach
// the compiler before that). The checkbox refresher is wired up by the plugin.
let sandboxForFeatures: import("./vendor/sandbox").Sandbox | null = null
let refreshFeatureChecks: () => void = () => {}

function setFeatures(names: Iterable<string>) {
  enabledFeatures.clear()
  for (const name of names) enabledFeatures.add(name)
  applyFeatures()
}

// ---- the TS++ Features sidebar plugin ------------------------------------------------------
const featuresPlugin: PluginFactory = () => {
  const plugin: PlaygroundPlugin = {
    id: "tspp-features",
    displayName: "TS++ Features",
    didMount(_sandbox, container) {
      const intro = document.createElement("p")
      intro.innerHTML =
        "Enable TS++ language features for this session.<br>Dependencies are enabled automatically."
      container.appendChild(intro)

      const inputs = new Map<string, HTMLInputElement>()

      refreshFeatureChecks = () => {
        const { expanded, implicitBy } = featureEffectState()
        for (const [name, input] of inputs) {
          const implicit = !enabledFeatures.has(name) && expanded.has(name)
          input.checked = expanded.has(name)
          input.indeterminate = implicit
          input.disabled = implicit
          const label = input.parentElement as HTMLElement
          label.classList.toggle("tspp-feature-implicit", implicit)
          const pulledBy = implicitBy.get(name)?.join(", ")
          const def = tsppFeatureDefinitions.find(d => d.name === name)
          label.title = implicit
            ? `Implicitly enabled via: ${pulledBy}`
            : def && def.dependencies.length
              ? `Also enables: ${def.dependencies.join(", ")}`
              : ""
        }
      }

      for (const def of tsppFeatureDefinitions) {
        const label = document.createElement("label")
        label.className = "tspp-feature-option"
        label.style.display = "block"
        label.style.margin = "6px 0"

        const input = document.createElement("input")
        input.type = "checkbox"
        input.checked = enabledFeatures.has(def.name)
        inputs.set(def.name, input)
        input.onchange = () => {
          if (input.checked) enabledFeatures.add(def.name)
          else enabledFeatures.delete(def.name)
          // non-empty tsppFeatures is what makes the compiler include .tspp files
          applyFeatures()
        }

        const text = document.createElement("span")
        text.textContent = " " + def.name

        // initComments is the feature's summary from the compiler sources
        // (first line: what it grants; second: superset/erasure notes)
        const desc = document.createElement("div")
        desc.className = "tspp-feature-desc"
        desc.style.cssText = "margin-left:20px;font-size:0.85em;opacity:0.75"
        desc.textContent = (def.initComments ?? []).join(" ")

        label.appendChild(input)
        label.appendChild(text)
        label.appendChild(desc)
        container.appendChild(label)
      }

      refreshFeatureChecks()

      const note = document.createElement("p")
      note.innerHTML = "<em>Changes recompile instantly (the worker restarts).</em>"
      container.appendChild(note)
    },
  }
  return plugin
}

// ---- boot ----------------------------------------------------------------------------------
async function boot() {
  const container = document.getElementById("playground-container")!

  const params = new URLSearchParams(location.search)
  const filetype = (params.get("filetype") as "tspp" | null) ?? "tspp"

  const urlFeatures = params.get("tsppFeatures")
  if (urlFeatures) {
    enabledFeatures.clear()
    for (const name of urlFeatures.split(",").map(x => x.trim()).filter(Boolean)) {
      enabledFeatures.add(name)
    }
    localStorage.setItem("tsppFeatures", JSON.stringify([...enabledFeatures]))
  }

  // ?example=<id> loads an example directly from the URL (like #example/... but it
  // also applies the example's feature set and beats the sandbox-history restore,
  // so a link always reproduces the exact example state).
  const exampleOverride = params.get("example")
  const overrideExample = exampleOverride ? examples.find(x => x.id === exampleOverride) : undefined
  if (overrideExample) {
    enabledFeatures.clear()
    for (const name of overrideExample.features) enabledFeatures.add(name)
    localStorage.setItem("tsppFeatures", JSON.stringify([...enabledFeatures]))
  }

  const declarationUrl = new URL(
    useDevCompiler ? "typescript.dev.d.ts" : "vendor/typescript.d.ts",
    document.baseURI,
  ).href
  const declarationResponse = await fetch(declarationUrl)
  if (!declarationResponse.ok) {
    throw new Error(`HTTP ${declarationResponse.status} ${declarationResponse.statusText} fetching ${declarationUrl}`)
  }
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    await declarationResponse.text(),
    "file:///node_modules/ts-plus-plus/index.d.ts",
  )
  // ts-plus-plus/smt and ts-plus-plus/macros: typings only; the compiler serves the modules.
  const facadesUrl = new URL(useDevCompiler ? "facades.dev.json" : "vendor/facades.json", document.baseURI).href
  const facadesResponse = await fetch(facadesUrl)
  if (facadesResponse.ok) {
    const facades = await facadesResponse.json() as Record<string, string>
    for (const [path, text] of Object.entries(facades)) monaco.languages.typescript.typescriptDefaults.addExtraLib(text, path)
  }

  const sandboxEnv = await createTypeScriptSandbox(
    {
      text: overrideExample?.code ?? examples[2].code,
      compilerOptions: {
        // non-empty tsppFeatures gates .tspp inclusion (#22) — default to data declarations
        tsppFeatures: expandDependencies(enabledFeatures.size ? enabledFeatures : defaultFeatures),
      },
      domID: "monaco-editor-embed",
      filetype,
      acquireTypes: false,
      supportTwoslashCompilerOptions: true,
      monacoSettings: { fontFamily: "Consolas, Monaco, monospace", automaticLayout: true },
    },
    monaco,
    tspp as unknown as typeof import("typescript"),
  )

  // Reveal + size the container only now: the loader (still in the DOM above us)
  // occupies vertical space, so a top-based height measured while it is present
  // collapses the editor to a strip once the loader is removed. Measuring the
  // toolbar's bottom edge is independent of whether the loader is still present.
  const sizeContainer = () => {
    const toolbar = document.getElementById("editor-toolbar")
    const top = toolbar ? toolbar.getBoundingClientRect().bottom : container.getBoundingClientRect().top
    container.style.display = "flex"
    container.style.height = `${Math.max(window.innerHeight - Math.ceil(top) - 8, 400)}px`
  }
  const loader = document.getElementById("loader")
  loader?.parentElement?.removeChild(loader)
  sizeContainer()

  // The ts mode (and its worker) is initialized asynchronously after the editor's model
  // activates the "typescript" language. Sidebar plugins call getWorkerProcess on mount,
  // so wait for the mode here — otherwise the first render races
  // ("TypeScript not registered!" rejections). The first worker chunk is ~10MB, so the
  // wait must tolerate a cold start; on timeout keep mounting the UI anyway — the mode
  // finishes loading in the background and the worker self-heals on first use.
  for (let attempt = 0; ; attempt++) {
    try {
      await sandboxEnv.getWorkerProcess()
      break
    } catch (error) {
      if (attempt >= 600) {
        console.error("TypeScript mode did not initialize in time; mounting UI anyway", error)
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const playground = setupPlayground(
    sandboxEnv,
    monaco,
    {
      lang: "en",
      // site prefix for the example loader: the directory containing index.html,
      // so it works both on GitHub Pages (/playground/) and in local dev (/)
      prefix: document.location.pathname.replace(/\/[^/]*$/, "/"),
      supportCustomPlugins: false,
      plugins: [...getPlaygroundPlugins(), featuresPlugin],
    },
    i,
    undefined as never,
  )

  sandboxForFeatures = sandboxEnv

  monaco.editor.setTheme("sandbox-dark")
  sandboxEnv.editor.focus()
  sandboxEnv.editor.layout()

  // ---- examples dialog (vanilla replacement for the official React component) ---------------
  const examplesList = document.getElementById("examples-list")!
  // Multi-file examples render a tab strip between the toolbar and the editor; the
  // files travel inside src/examples.js (generated with each project's full src/).
  const exampleFileBar = document.getElementById("example-file-bar")!
  const containerEl = document.getElementById("playground-container")!
  const fileTabs: { button: HTMLButtonElement; code: string }[] = []
  const setExampleFiles = (example: (typeof examples)[number]) => {
    fileTabs.length = 0
    exampleFileBar.replaceChildren()
    const files = (example as { files?: { name: string; code: string }[] }).files
    containerEl.classList.toggle("has-example-files", !!files?.length)
    if (!files?.length) return
    for (const file of files) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "example-file-tab"
      button.textContent = file.name
      button.onclick = () => {
        sandboxEnv.setText(file.code)
        for (const tab of fileTabs) tab.button.classList.toggle("active", tab.button === button)
      }
      fileTabs.push({ button, code: file.code })
      exampleFileBar.appendChild(button)
    }
    fileTabs[0].button.classList.add("active")
  }
  // A deep link (?example=<id>) to a multi-file example also shows its file tabs;
  // the entry file is already in the editor via the sandbox text above.
  if (overrideExample) setExampleFiles(overrideExample)
  for (const example of examples) {
    const link = document.createElement("a")
    link.className = "example-link"
    link.href = `#example/${example.id}`
    link.textContent = example.title
    link.onclick = async e => {
      e.preventDefault()
      const { code } = await getExampleSourceCode(document.location.pathname.replace(/\/[^/]*$/, "/"), "en", example.id)
      if (!code) {
        // local fallback: the TOC fetch only works on the deployed site paths we ship
        sandboxEnv.setText(example.code)
      } else {
        sandboxEnv.setText(code)
      }
      setExampleFiles(example)
      const exampleFeatures = examples.find(x => x.id === example.id)?.features ?? []
      // setFeatures stores the manual selection and lets expandDependencies pull in
      // the dependency closure — the sidebar checkboxes reflect the implicit ones.
      setFeatures(exampleFeatures)
      document.title = `TS++ Playground - ${example.title}`
      playground.ui.flashInfo(`Loaded example: ${example.title}`)
      document.querySelectorAll(".navbar-sub li.open").forEach(el => el.classList.remove("open"))
      return false
    }
    examplesList.appendChild(link)
  }

  // ---- export menu wiring -------------------------------------------------------------------
  const exports = [
    ["export-copy-md", () => playground.exporter.copyAsMarkdownIssue({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent)],
    ["export-copy-link", () => playground.exporter.copyForChat({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent)],
    ["export-copy-link-preview", () => playground.exporter.copyForChatWithPreview({ preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent)],
  ] as const
  for (const [id, fn] of exports) {
    const el = document.getElementById(id)
    if (el) el.onclick = fn
  }

  // ---- verification diagnostics sync ---------------------------------------------------------
  // The compiler solves formal contracts asynchronously (browser Z3): an edit lands
  // as a placeholder program first (no verification diagnostics), the solve settles
  // later, and nothing in monaco's TS DiagnosticsAdapter revalidates on that
  // transition. The loop below is therefore the single writer for verification
  // markers: it polls the worker's artifacts (cheap RPC; the same worker the Verify
  // tab reads — one source of truth) and, whenever the artifact set changes, maps
  // the non-proved obligations onto editor markers under the dedicated
  // "tspp-verification" owner. The adapter filters 18090 out of its own validation
  // (see sandbox/index.ts), so owner separation keeps the two writers disjoint and
  // the editor/Errors tab can never double-count a verification result.
  const VERIFICATION_MARKER_OWNER = "tspp-verification"
  let lastArtifactsJson: string | undefined
  const syncVerificationDiagnostics = async () => {
    try {
      const worker = await sandboxEnv.getWorkerProcess()
      const artifacts = (await worker.getVerificationArtifacts()) ?? []
      const json = JSON.stringify(artifacts.map(a => [a.taskId, a.status, a.message, a.counterexample]))
      if (json === lastArtifactsJson) return
      lastArtifactsJson = json
      const model = sandboxEnv.getModel()
      if (model.isDisposed()) return
      const markers: import("monaco-editor").editor.IMarkerData[] = []
      for (const artifact of artifacts) {
        if (artifact.status === "proved") continue
        const start = Number.isFinite(artifact.start) ? artifact.start : 0
        const length = Number.isFinite(artifact.length) && artifact.length > 0 ? artifact.length : 1
        const startPos = model.getPositionAt(start)
        const endPos = model.getPositionAt(start + length)
        const failed = artifact.status === "failed"
        const parts = [artifact.message || artifact.reason?.message || "verification did not pass"]
        if (artifact.counterexample) parts.push(`Counterexample: ${artifact.counterexample}`)
        markers.push({
          severity: failed ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
          message: parts.join("\n"),
          source: "TS++ verification",
        })
      }
      monaco.editor.setModelMarkers(model, VERIFICATION_MARKER_OWNER, markers)
    } catch {
      // worker still booting or RPC hiccups: retry on the next tick
    }
  }
  const verificationSyncTimer = window.setInterval(() => void syncVerificationDiagnostics(), 1500)

  window.addEventListener("resize", () => {
    sizeContainer()
    sandboxEnv.editor.layout()
  })
}

boot().catch(error => {
  console.error(error)
  const message = document.getElementById("loading-message")
  if (message) message.textContent = `Failed to load the playground: ${error.message}`
})
