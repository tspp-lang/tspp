import type * as lsp from 'vscode-languageserver';
import { Commands } from '../commands.js';
import { TSServerRequestCommand } from '../commands/tsserverRequests.js';
import { ServerResponse } from '../typescriptService.js';

/** Commands of the quick fix provider, which upstream names only inside its own module. */
export const applyCodeActionCommand = '_typescript.applyCodeActionCommand';
export const applyFixAllCodeActionCommand = '_typescript.applyFixAllCodeAction';

// VS Code registers LSP commands globally, alongside its built-in TypeScript commands.
const vscodeCommandAliases = new Map([
    [Commands.CONFIGURE_PLUGIN, 'tspp.configurePlugin'],
    [applyCodeActionCommand, 'tspp.applyCodeActionCommand'],
    [applyFixAllCodeActionCommand, 'tspp.applyFixAllCodeAction'],
    [TSServerRequestCommand.ID, 'tspp.tsserverRequest'],
]);
const vscodeServerCommands = new Map(Array.from(vscodeCommandAliases, ([command, alias]) => [alias, command]));

/** The command ids the client sees, which differ from the server's own only for the TS++ VS Code extension. */
export class ClientCommands {
    private useVscodeAliases = false;

    configure(hostInfo: string | undefined): void {
        this.useVscodeAliases = hostInfo === 'vscode-tspp';
    }

    toClient(command: string): string {
        return this.useVscodeAliases ? vscodeCommandAliases.get(command) ?? command : command;
    }

    /** The request with the server's own id for the command the client sent. */
    toServer<T extends lsp.ExecuteCommandParams>(params: T): T {
        const command = this.useVscodeAliases ? vscodeServerCommands.get(params.command) : undefined;
        return command ? { ...params, command } : params;
    }

    aliasActions<T extends lsp.CodeAction | lsp.Command>(actions: T[]): T[] {
        for (const action of actions) {
            this.aliasCommand(isCommand(action) ? action : action.command);
        }
        return actions;
    }

    aliasAction(action: lsp.CodeAction): lsp.CodeAction {
        this.aliasCommand(action.command);
        return action;
    }

    private aliasCommand(command: lsp.Command | undefined): void {
        if (command) {
            command.command = this.toClient(command.command);
        }
    }
}

function isCommand(action: lsp.CodeAction | lsp.Command): action is lsp.Command {
    return typeof action.command === 'string';
}

function isProjectInitializationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('TypeScript Server Error')
        && message.includes('Cannot read properties of undefined')
        && message.includes('getSourceFile');
}

/** The answer of a request, or `fallback` when tsserver failed because the file's project is still initializing. */
export async function guardProjectInitialization<T, F>(work: Promise<T>, fallback: F): Promise<T | F> {
    try {
        return await work;
    } catch (error) {
        if (isProjectInitializationError(error)) {
            return fallback;
        }
        throw error;
    }
}

/** Process handlers that a server removes again on shutdown, so that servers created one after another don't pile up. */
export class ProcessHandlers {
    private installed = false;
    private readonly onExit = () => this.shutdown();
    private readonly onSigint = () => process.exit();

    constructor(private readonly shutdown: () => void) {}

    install(): void {
        process.on('exit', this.onExit);
        process.on('SIGINT', this.onSigint);
        this.installed = true;
    }

    uninstall(): void {
        if (this.installed) {
            process.off('exit', this.onExit);
            process.off('SIGINT', this.onSigint);
            this.installed = false;
        }
    }
}

/** A tsserver request whose failure while the project initializes reads as no content. */
export function guardRequest<T>(work: Promise<T>): Promise<T | typeof ServerResponse.NoContent> {
    return guardProjectInitialization(work, ServerResponse.NoContent);
}
