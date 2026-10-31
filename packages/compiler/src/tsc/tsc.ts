import * as ts from "./_namespaces/ts.js";

// This file actually uses arguments passed on commandline and executes it

// enable deprecation logging
ts.Debug.loggingHost = {
    log(_level, s) {
        ts.sys.write(`${s || ""}${ts.sys.newLine}`);
    },
};

if (ts.Debug.isDebugging) {
    ts.Debug.enableDebugInfo();
}

if (ts.sys.tryEnableSourceMapsForHost && /^development$/i.test(ts.sys.getEnvironmentVariable("NODE_ENV"))) {
    ts.sys.tryEnableSourceMapsForHost();
}

if (ts.sys.setBlocking) {
    ts.sys.setBlocking();
}

ts.initializeTSPPCompilerPlugins(ts.version);
Promise.resolve(ts.executeCommandLineAsync(ts.sys, ts.noop, ts.sys.args)).catch(error => {
    ts.sys.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}${ts.sys.newLine}`);
    ts.sys.exit?.(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
});
