/**
 * Monaco without its bundled languages: editor.main also pulls in every Monarch
 * grammar plus the TypeScript/CSS/HTML/JSON language services (and their workers),
 * none of which the playground uses. Only the editor contributions it needs are
 * imported here; the list mirrors monaco-editor/esm/vs/editor/editor.main.js.
 */
import "monaco-editor/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/common/standaloneStrings.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";

export * from "monaco-editor/editor/editor.api.js";
