/// <reference path="fourslash.ts"/>

// @Filename: /library.ts
////export const value = 1;

// @Filename: /consumer.ts
////import * as smt from "./library";
////smt.value;

goTo.file("/consumer.ts");

const c = classification("2020");
verify.semanticClassificationsAre("2020",
    c.semanticToken("namespace", "smt"),
    c.semanticToken("variable.readonly", "value"),
);
