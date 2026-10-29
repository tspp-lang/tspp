import * as ts from "../../_namespaces/ts.js";
import {
  baselineTsserverLogs,
  closeFilesForSession,
  openFilesForSession,
  protocolFileLocationFromSubstring,
  TestSession,
} from "../helpers/tsserver.js";
import {
  File,
  TestServerHost,
} from "../helpers/virtualFileSystemWithWatch.js";

describe("unittests:: tsserver:: configFileSearch:: searching for config file", () => {
  it("discovers tsppconfig.json for .tspp files", () => {
    const file = {
      path: "/home/src/workspaces/project/index.tspp",
      content: "type Identity: Type1 = (A: Type0) -> A;",
    };
    const configFile = {
      path: "/home/src/workspaces/project/tsppconfig.json",
      content: '{ "compilerOptions": { "tsppFeatures": ["higherKindedTypes", "typeUniverses", "dependentFunctionTypes"] } }',
    };
    const host = TestServerHost.createServerHost([file, configFile]);
    const session = new TestSession(host);
    openFilesForSession([file], session);

    const projects = [...session.getProjectService().configuredProjects.values()];
    assert.lengthOf(projects, 1);
    assert.strictEqual(projects[0].getConfigFilePath(), configFile.path);
    assert.deepEqual(projects[0].getCompilationSettings().tsppFeatures, ["higherKindedTypes", "typeUniverses", "dependentFunctionTypes"]);
  });

  it("serializes instantiated dependent Boolean signatures in quick info", () => {
    const file = {
      path: "/home/src/workspaces/project/index.tspp",
      content: `
type BooleanChooser: Type0 =
  (value: Bool) ->
  If<
    value,
    Ann<Lam<(ignored: Bool) -> Type0>, (ignored: Bool) -> Type1>,
    string,
    number
  >;
declare const chooseByBoolean: BooleanChooser;
const chosenString = chooseByBoolean(true);
`,
    };
    const configFile = {
      path: "/home/src/workspaces/project/tsppconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          strict: true,
          tsppFeatures: ["higherKindedTypes", "typeUniverses", "dependentFunctionTypes", "dependentFunctionInterop", "booleans", "booleanElimination"],
        },
      }),
    };
    const host = TestServerHost.createServerHost([file, configFile]);
    const session = new TestSession(host);
    openFilesForSession([file], session);

    const response = session.executeCommandSeq<ts.server.protocol.QuickInfoRequest>({
      command: ts.server.protocol.CommandTypes.Quickinfo,
      arguments: protocolFileLocationFromSubstring(file, "chooseByBoolean(true)"),
    }).response as ts.server.protocol.QuickInfoResponseBody;
    assert.strictEqual(response.displayString, "const chooseByBoolean: <true>(value: true) => string");
  });

  it("serializes instantiated type-match signatures in quick info", () => {
    const file = {
      path: "/home/src/workspaces/project/index.tspp",
      content: `
type MatchValue: Type1 =
  {A: Type0} ->
  (value: A) ->
  TypeMatch<A, Case<string, number>, Case<number, string>, Default<boolean>>;
declare const matchValue: MatchValue;
declare let text: string;
const matchedText = matchValue(text);
`,
    };
    const configFile = {
      path: "/home/src/workspaces/project/tsppconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          strict: true,
          tsppFeatures: ["higherKindedTypes", "typeUniverses", "dependentFunctionTypes", "dependentFunctionInterop", "typeMatching"],
        },
      }),
    };
    const host = TestServerHost.createServerHost([file, configFile]);
    const session = new TestSession(host);
    openFilesForSession([file], session);

    const response = session.executeCommandSeq<ts.server.protocol.QuickInfoRequest>({
      command: ts.server.protocol.CommandTypes.Quickinfo,
      arguments: protocolFileLocationFromSubstring(file, "matchValue(text)"),
    }).response as ts.server.protocol.QuickInfoResponseBody;
    assert.strictEqual(response.displayString, "const matchValue: <string>(value: string) => number");
  });

  it("should stop at projectRootPath if given", () => {
    const f1 = {
      path: "/home/src/project/project/a/file1.ts",
      content: "",
    };
    const configFile = {
      path: "/home/src/project/project/tsconfig.json",
      content: "{}",
    };
    const host = TestServerHost.createServerHost([f1, configFile]);
    const session = new TestSession(host);
    openFilesForSession([{ file: f1, projectRootPath: "/home/src/project/project/a" }], session);

    closeFilesForSession([f1], session);
    openFilesForSession([f1], session);
    baselineTsserverLogs("configFileSearch", "should stop at projectRootPath if given", session);
  });

  it("should use projectRootPath when searching for inferred project again", () => {
    const projectRootPath = "/home/a/b/projects/project";
    const configFileLocation = `${projectRootPath}/src`;
    const f1 = {
      path: `${configFileLocation}/file1.ts`,
      content: "",
    };
    const configFile = {
      path: `${configFileLocation}/tsconfig.json`,
      content: "{}",
    };
    const configFile2 = {
      path: "/home/a/b/projects/tsconfig.json",
      content: "{}",
    };
    const host = TestServerHost.createServerHost([f1, configFile, configFile2]);
    const session = new TestSession(host);
    openFilesForSession([{ file: f1, projectRootPath }], session);

    // Delete config file - should create inferred project and not configured project
    host.deleteFile(configFile.path);
    host.runQueuedTimeoutCallbacks();
    baselineTsserverLogs("configFileSearch", "should use projectRootPath when searching for inferred project again", session);
  });

  it("should use projectRootPath when searching for inferred project again 2", () => {
    const projectRootPath = "/home/a/b/projects/project";
    const configFileLocation = `${projectRootPath}/src`;
    const f1 = {
      path: `${configFileLocation}/file1.ts`,
      content: "",
    };
    const configFile = {
      path: `${configFileLocation}/tsconfig.json`,
      content: "{}",
    };
    const configFile2 = {
      path: "/home/a/b/projects/tsconfig.json",
      content: "{}",
    };
    const host = TestServerHost.createServerHost([f1, configFile, configFile2]);
    const session = new TestSession({
      host,
      useSingleInferredProject: true,
      useInferredProjectPerProjectRoot: true,
    });
    openFilesForSession([{ file: f1, projectRootPath }], session);

    // Delete config file - should create inferred project with project root path set
    host.deleteFile(configFile.path);
    host.runQueuedTimeoutCallbacks();
    baselineTsserverLogs("configFileSearch", "should use projectRootPath when searching for inferred project again 2", session);
  });

  describe("when the opened file is not from project root", () => {
    const projectRoot = "/a/b/projects/project";
    const file: File = {
      path: `${projectRoot}/src/index.ts`,
      content: "let y = 10",
    };
    const tsconfig: File = {
      path: `${projectRoot}/tsconfig.json`,
      content: "{}",
    };
    function openClientFile(files: File[]) {
      const host = TestServerHost.createServerHost(files);
      const session = new TestSession(host);
      openFilesForSession([{ file, projectRootPath: "/a/b/projects/proj" }], session);
      return { host, session };
    }

    it("tsconfig for the file exists", () => {
      const { host, session } = openClientFile([file, tsconfig]);

      host.deleteFile(tsconfig.path);
      host.runQueuedTimeoutCallbacks();

      host.writeFile(tsconfig.path, tsconfig.content);
      host.runQueuedTimeoutCallbacks();

      baselineTsserverLogs("configFileSearch", "tsconfig for the file exists", session);
    });

    it("tsconfig for the file does not exist", () => {
      const { host, session } = openClientFile([file]);

      host.writeFile(tsconfig.path, tsconfig.content);
      host.runQueuedTimeoutCallbacks();

      host.deleteFile(tsconfig.path);
      host.runQueuedTimeoutCallbacks();

      baselineTsserverLogs("configFileSearch", "tsconfig for the file does not exist", session);
    });
  });

  describe("should not search and watch config files from directories that cannot be watched", () => {
    function verifyConfigFileWatch(scenario: string, projectRootPath: string | undefined) {
      it(scenario, () => {
        const path = `/root/teams/VSCode68/Shared Documents/General/jt-ts-test-workspace/x.js`;
        const host = TestServerHost.createServerHost([{ path, content: "const x = 10" }], { useCaseSensitiveFileNames: true });
        const session = new TestSession(host);
        openFilesForSession([{ file: path, projectRootPath }], session);
        baselineTsserverLogs("configFileSearch", scenario, session);
      });
    }
    verifyConfigFileWatch("when projectRootPath is not present", /*projectRootPath*/ undefined);
    verifyConfigFileWatch("when projectRootPath is present but file is not from project root", "/a/b");
  });
});
