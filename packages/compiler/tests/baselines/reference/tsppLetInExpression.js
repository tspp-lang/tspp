//// [tests/cases/compiler/tsppLetInExpression.ts] ////

//// [tsppLetInExpression.ts]
const total: number = let left = 20, right = 22 in left + right;
const greeting: string = let name = "TSPP" in `hello ${name}`;
const destructured: number = let { value } = { value: 7 } in value;
const nested: number = let seed = 1 in let doubled = seed * 2 in doubled + 3;


//// [tsppLetInExpression.js]
"use strict";
const total = (() => {
    let left = 20, right = 22;
    return left + right;
})();
const greeting = (() => {
    let name = "TSPP";
    return `hello ${name}`;
})();
const destructured = (() => {
    let { value } = { value: 7 };
    return value;
})();
const nested = (() => {
    let seed = 1;
    return (() => {
        let doubled = seed * 2;
        return doubled + 3;
    })();
})();
