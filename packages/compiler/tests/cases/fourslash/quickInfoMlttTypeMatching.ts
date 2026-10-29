/// <reference path="fourslash.ts"/>

// @tsppFeatures: higherKindedTypes,typeUniverses,dependentFunctionTypes,dependentFunctionInterop,typeMatching

// @Filename: test.tspp
////type MatchValue: Type1 =
////  {A: Type0} ->
////  (value: A) ->
////  TypeMatch<
////    A,
////    Case<string, number>,
////    Case<number, string>,
////    Default<boolean>
////  >;
////declare const matchValue: MatchValue;
////declare let text: string;
////declare let count: number;
////declare let textOrCount: string | number;
////const /*textResult*/matchedText = /*textCall*/matchValue(text);
////const /*numberResult*/matchedNumber = matchValue(count);
////const /*unionResult*/matchedUnion = matchValue(textOrCount);
////type UnwrapArray: Type1 =
////  {A: Type0} ->
////  (value: A) ->
////  TypeMatch<A, Case<Array<infer T>, T>, Default<A>>;
////declare const unwrapArray: UnwrapArray;
////declare let textArray: Array<string>;
////declare let countArray: Array<number>;
////const /*textElementResult*/textElement = /*textElementCall*/unwrapArray(textArray);
////const /*countElementResult*/countElement = unwrapArray(countArray);

verify.quickInfoAt("textResult", "const matchedText: number");
verify.quickInfoAt("numberResult", "const matchedNumber: string");
verify.quickInfoAt("unionResult", "const matchedUnion: boolean");
verify.quickInfoAt("textCall", "const matchValue: <string>(value: string) => number");
verify.quickInfoAt("textElementResult", "const textElement: string");
verify.quickInfoAt("countElementResult", "const countElement: number");
verify.quickInfoAt("textElementCall", "const unwrapArray: <string[]>(value: string[]) => string");
