const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
usePlugins(require("../dist").advancedClassesPlugin);
function compile(files, options = {}) {
  const { program, outputs } = createProgram(files, { noLib: false, ...options });
  const messages = diagnosticMessages(program);
  return { program, messages, codes: [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(d => d.code), run() {
    assert.deepEqual(messages, []); program.emit(); const modules = new Map();
    const load = name => { if (modules.has(name)) return modules.get(name).exports;
      const module = { exports: {} }; modules.set(name, module);
      new Function("exports", "require", "module", outputs.get(`${name}.js`))(module.exports, path => load(path.replace(/^\.\//, "/")), module);
      return module.exports;
    }; return load("/main");
  }};
}

test("mapped tuples check overloads, generic substitutions, and argument counts", () => {
  const result = compile(`
    class A { constructor(n: number); constructor(s: string, flag: boolean); constructor(n: number|string, flag?: boolean) {} }
    class B<T> { constructor(value: T, optional?: number) {} }
    class Good extends A, B<string> { constructor() { super({A: ["x", true], B: ["ok"]}); } }
    class WrongA extends A, B<string> { constructor() { super({A: [true], B: ["ok"]}); } }
    class WrongB extends A, B<string> { constructor() { super({A: [1], B: [22]}); } }
    class Missing extends A, B<string> { constructor() { super({A: [], B: ["ok"]}); } }
  `);
  assert(result.messages.some(message => message.includes("boolean") && message.includes("number")), result.messages.join("\n"));
  assert(result.messages.some(message => message.includes("number") && message.includes("string")), result.messages.join("\n"));
  assert(result.messages.some(message => message.includes("Expected 1-2 arguments")), result.messages.join("\n"));
});

test("mapped tuples diagnose missing, duplicate, unknown, and malformed base entries", () => {
  for (const [map, word] of [["A: []", "missing"], ["A: [], A: [], B: []", "more than once"], ["A: [], B: [], C: []", "Unknown"], ["A: 3, B: []", "Each mapped"], ["A: [], ...{}", "Each mapped"], ["A: [,], B: []", "holes"]]) {
    const result = compile(`class A {} class B {} class C extends A, B {constructor(){super({${map}})}}`);
    assert(result.codes.includes(19126), result.messages.join("\n"));
    assert(result.messages.some(message => message.includes(word)), result.messages.join("\n"));
  }
});

test("defaults, rest, destructuring, parameter properties and standalone constructors retain values", () => {
  for (const useDefineForClassFields of [true, false]) {
    const result = compile(`
      class A { constructor(public value = 3, ...rest: number[]) { this.total = value + rest.reduce((a,b)=>a+b,0); } total: number; }
      class B { constructor(public label: string, {suffix}: {suffix:string} = {suffix:"!"}) { this.label += suffix; } }
      class C extends A, B { constructor(){super({B:["mapped"], A:[undefined,4,5]})} }
      const c = new C(); const a = new A(7,8); const b = new B("plain", {suffix:"?"});
      export const result=[c.value,c.total,c.label,a.value,a.total,b.label,c instanceof A,c instanceof B];
    `, { useDefineForClassFields });
    assert.deepEqual(result.run().result, [3,12,"mapped!",7,15,"plain?",true,true]);
  }
});

test("cross-file namespace bases and imported aliases select actual identities", () => {
  const result = compile({
    "/a.tspp": `export class A<T> {constructor(public value:T){} a(){return this.value}}`,
    "/b.tspp": `export class B {constructor(public label:string){} b(){return this.label}}`,
    "/main.tspp": `
      import {A as Alias} from "./a"; import * as ns from "./b";
      class C extends Alias<number>, ns.B { constructor(){super({[ns.B]:["b"], Alias:[7]})} read(){return [super[Alias].a(),super[ns.B].b()]}}
      export const result=new C().read();
    `,
  });
  assert.deepEqual(result.run().result, [7,"b"]);
});

test("mapped bases preserve prototype restrictions on every transformed identity", () => {
  const result=compile(`class A {} class B {} class C extends A,B{constructor(){super({A:[],B:[]})}} A.prototype; B.prototype; Object.getPrototypeOf(new A());`);
  assert.equal(result.codes.filter(code=>code===19125).length,3,result.messages.join("\n"));
});

test("unsafe copied constructors and computed members receive explicit restrictions", () => {
  for(const [body,word] of [["constructor(){return {};}","returns a value"],["constructor(){console.log(arguments)}","references arguments"],["[Symbol.iterator](){return this}","computed member"]]){
    const result=compile(`class A {${body}} class B {} class C extends A,B{constructor(){super({A:[],B:[]})}}`);
    assert(result.codes.includes(19121)); assert(result.messages.some(message=>message.includes(word)),result.messages.join("\n"));
  }
  const external=compile({"/base.ts":"export class A {}","/main.tspp":"import {A} from './base'; class B {} class C extends A,B{constructor(){super({A:[],B:[]})}}"});
  assert(external.messages.some(message=>message.includes("a mapped base")&&message.includes(".tspp")),external.messages.join("\n"));
});

test("unqualified and invalid qualified super accesses require explicit disambiguation",()=>{
  for(const expression of ["super.a()","super[A].field","super[A].a = ()=>1","super[A].a?.()","super[Bogus].a()","super[A]"]){
    const result=compile(`class A {field=1;a(){return 1}} class B {} class Bogus{} class C extends A,B{constructor(){super({A:[],B:[]})}x(){return ${expression}}}`);
    assert(result.codes.includes(19127),expression+": "+result.messages.join("\n"));
  }
});

test("legacy constructors pass arguments to the first base and optional additional defaults run independently",()=>{
  const result=compile(`class A {constructor(public a:number){}} class B {constructor(public b=2){}} class C extends A,B{constructor(){super(7)}} export const result=[new C().a,new C().b,new B(9).b];`);
  assert.deepEqual(result.run().result,[7,2,9]);
});

test("abstract and protected constructors are callable through mapped super",()=>{
  const result=compile(`abstract class A {protected constructor(public a:number){} abstract foo():number;} class B {} class C extends A,B{constructor(){super({A:[1],B:[]})}foo(){return this.a}} export const result=new C().foo();`);
  assert.deepEqual(result.run().result,1);
});

test("constructor arguments keep contextual lambda and literal typing",()=>{
  const result=compile(`class A {constructor(public fn:(n:number)=>number, public options:{kind:"ok"}){}} class B{} class C extends A,B{constructor(){super({A:[n=>n+1,{kind:"ok"}],B:[]})}} export const result=new C().fn(3);`);
  assert.deepEqual(result.run().result,4);
});

test("alternate alias spellings are rejected before generic substitutions can be lost",()=>{
  const result=compile({"/base.tspp":"export class A<T>{constructor(public value:T){} foo():T{return this.value;}}", "/main.tspp":`import {A,A as Alias} from './base'; class B{} class C extends A<number>,B {constructor(){super({[Alias]:['wrong'],B:[]})} x():string{return super[Alias].foo();}}`});
  assert(result.codes.includes(19126)); assert(result.codes.includes(19127));
  assert(result.messages.some(message=>message.includes("base spelling from extends")),result.messages.join("\n"));
});

test("copied bases keep target-specific parameter-default and field initialization order",()=>{
  for(const target of [ts.ScriptTarget.ES2020,ts.ScriptTarget.ES2022]) for(const useDefineForClassFields of [true,false]) {
    for(const field of ["x=1;", "#x=1;"]) {
      const read=field.startsWith("#")?"this.#x":"this.x";
      const source=`const events:string[]=[]; class A {${field} constructor(value=${read}){events.push(String(value))}} class B{} REPLACE try {new A()}catch{events.push('throw')} export const result=events;`;
      const ordinary=compile(source.replace('REPLACE',''),{target,useDefineForClassFields}).run().result;
      const mapped=compile(source.replace('REPLACE','class C extends A,B{constructor(){super({A:[],B:[]})}}'),{target,useDefineForClassFields}).run().result;
      assert.deepEqual(mapped,ordinary,`${target}/${useDefineForClassFields}/${field}`);
    }
  }
});

test("qualified super respects lexical function scopes and rejects destructuring targets",()=>{
  const nested=compile(`class A {a(){return 1}} class B {} class C extends A,B{constructor(){super({A:[],B:[]})} x(){return function(this:C){return super[A].a()}}}`);
  assert(nested.messages.length>0);
  const assignment=compile(`class A {get value(){return 1}} class B{} class C extends A,B{constructor(){super({A:[],B:[]})} x(obj:{x:number}){({x:super[A].value}=obj)}}`);
  assert(assignment.codes.includes(19127));
});

test("mapped argument flow reports premature this and unassigned reads and keeps assignments definite",()=>{
  const earlyThis=compile(`class A{constructor(n:number){}}class B{}class C extends A,B{x=1;constructor(){super({A:[this.x],B:[]})}}`);
  assert(earlyThis.codes.includes(17009),earlyThis.messages.join("\n"));
  const unassigned=compile(`class A{constructor(n:number){}}class B{}class C extends A,B{constructor(){let n:number;super({A:[n],B:[]})}}`);
  assert(unassigned.codes.includes(2454),unassigned.messages.join("\n"));
  const assigned=compile(`class A{constructor(public n:number){}}class B{}class C extends A,B{constructor(){let n:number;super({A:[n=1],B:[]});console.log(n)}}`);
  assert.deepEqual(assigned.messages,[]);
});

test("constructor map labels retain the heritage identity when a parameter shadows its name",()=>{
  const result=compile(`class A{constructor(public a:number){}}class B{}class C extends A,B{constructor(A:number){super({A:[A],B:[]})}} export const result=new C(7).a;`);
  assert.deepEqual(result.run().result,7);
});

test("abstract and protected errors inside supplied argument expressions remain visible",()=>{
  for(const hidden of ["abstract class Hidden{}", "class Hidden{protected constructor(){}}"]){
    const result=compile(`${hidden} class A{constructor(x:object){}} class B{} class C extends A,B{constructor(){super({A:[new Hidden()],B:[]})}}`);
    assert(result.codes.some(code=>[2511,2674].includes(code)),result.messages.join("\n"));
  }
});


test("qualified names with colliding short names retain separate identities",()=>{
  const result=compile({"/a.tspp":"export class Base{constructor(public a:number){} readA(){return this.a}}","/b.tspp":"export class Base{constructor(public b:string){} readB(){return this.b}}","/main.tspp":`import * as a from './a'; import * as b from './b'; class C extends a.Base,b.Base{constructor(){super({[b.Base]:['b'],[a.Base]:[3]})}read(){return [super[a.Base].readA(),super[b.Base].readB()]}} export const result=new C().read();`});
  assert.deepEqual(result.run().result,[3,"b"]);
});

test("qualified super uses the selected base member type without child members or overrides",()=>{
  const missing=compile(`class A{}class B{}class C extends A,B{constructor(){super({A:[],B:[]})}only(){return 1}x(){return super[A].only()}}`);
  assert(missing.codes.includes(2339),missing.messages.join("\n"));
  const override=compile(`class A{foo():string{return 'base'}}class B{}class C extends A,B{constructor(){super({A:[],B:[]})}foo():'child'{return 'child'}x(){const x:'child'=super[A].foo();return x;}}`);
  assert(override.codes.includes(2322),override.messages.join("\n"));
});


test("instanceof identities exist before defaults without initializing private methods early",()=>{
  for(const target of [ts.ScriptTarget.ES2020,ts.ScriptTarget.ES2022]){
    const result=compile(`class A{constructor(public ok:boolean=this instanceof A, public alsoB:boolean=this instanceof B){}} class B{} class C extends A,B{constructor(){super({A:[],B:[]})}} export const result=[new A().ok,new C().ok,new C().alsoB];`,{target});
    assert.deepEqual(result.run().result,[true,true,true]);
  }
});


test("qualified super rejects abstract members with no base implementation",()=>{
  const result=compile(`abstract class A{abstract foo():number;}class B{}class C extends A,B{constructor(){super({A:[],B:[]})}foo(){return 1}read(){return super[A].foo()}}`);
  assert(result.codes.includes(19127),result.messages.join("\n"));
});


test("copied fields retain inferred anonymous function and class names",()=>{
  for(const target of [ts.ScriptTarget.ES2020,ts.ScriptTarget.ES2022]) for(const useDefineForClassFields of [true,false]){
    const source=`class A{fn=()=>1;type=class{};#fn=()=>2;static fn=()=>3;names(){return [this.fn.name,this.type.name,this.#fn.name,A.fn.name]}}class B{}REPLACE export const result=new A().names();`;
    const ordinary=compile(source.replace('REPLACE',''),{target,useDefineForClassFields}).run().result;
    const mapped=compile(source.replace('REPLACE','class C extends A,B{constructor(){super({A:[],B:[]})}}'),{target,useDefineForClassFields}).run().result;
    assert.deepEqual(mapped,ordinary,`${target}/${useDefineForClassFields}`);
  }
});


test("mixed private and public fields retain their compiler-defined default timing",()=>{
  for(const target of [ts.ScriptTarget.ES2020,ts.ScriptTarget.ES2022]) for(const useDefineForClassFields of [true,false]){
    const source=`const events:string[]=[];class A{before=(events.push('before'),0);#x=(events.push('private'),1);after=(events.push('after'),0);constructor(x=this.#x){events.push(String(x))}}class B{}REPLACE try{new A()}catch{events.push('throw')}export const result=events;`;
    const ordinary=compile(source.replace('REPLACE',''),{target,useDefineForClassFields}).run().result;
    const mapped=compile(source.replace('REPLACE','class C extends A,B{constructor(){super({A:[],B:[]})}}'),{target,useDefineForClassFields}).run().result;
    assert.deepEqual(mapped,ordinary,`${target}/${useDefineForClassFields}`);
  }
});
