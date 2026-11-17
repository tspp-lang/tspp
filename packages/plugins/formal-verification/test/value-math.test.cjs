const assert = require('node:assert/strict');
const test = require('node:test');
const { expectVerification } = require('./analyze.cjs');
const { createProgram, diagnosticMessages, ts, usePlugins } = require('../../test-support/compile.cjs');
usePlugins(require('../../advanced-classes/dist'));

const pair = `interface Division { quotient: bigint; remainder: bigint; }
function divide(total: bigint, count: bigint) with {
  requires: total >= 0n && count > 0n;
  ensures: result.quotient >= 0n && result.remainder >= 0n && result.remainder < count
    && result.quotient * count + result.remainder === total;
}: Division { return { quotient: total / count, remainder: total % count }; }`;

test('data-class generated signatures do not acquire the following function contract, through the full compiler', async () => {
  const source = `data class Balances(source: bigint, destination: bigint)
function transfer(source: bigint, destination: bigint, amount: bigint) with {
  ensures: result.source === source - amount && result.destination === destination + amount
    && result.source + result.destination === source + destination;
}: Balances { return new Balances(source - amount, destination + amount); }`;
  const { program } = createProgram(source, { noLib: false });
  assert.deepEqual(diagnosticMessages(program), []);
  const diagnostics = await ts.runTSPPProgramAnalyzers(program);
  assert.deepEqual(diagnostics.map(item => item.message), []);
});

const cases = [
  {
    name: 'quotient and remainder summaries with exact distribution loop',
    source: `${pair}
function split(total: bigint, count: bigint): bigint[] {
  if (typeof total !== 'bigint' || typeof count !== 'bigint') throw new Error('types');
  if (total < 0n || count <= 0n) throw new Error('range');
  const { quotient, remainder } = divide(total, count);
  const shares: bigint[] = [];
  let index = 0n;
  let assigned = 0n;
  while (index < count) with {
    invariant: [index >= 0n, index <= count,
      assigned === index * quotient + (index < remainder ? index : remainder)];
  } {
    const share = index < remainder ? quotient + 1n : quotient;
    shares.push(share);
    assigned += share;
    index += 1n;
  }
  assert: assigned === total;
  return shares;
}`,
  },
  {
    name: 'record calls use fresh field symbols and destructuring renames',
    source: `${pair} function run() {
      const { quotient: first } = divide(10n, 2n);
      const { quotient: second } = divide(12n, 2n);
      assert: first === 5n && second === 6n;
    }`,
  },
  {
    name: 'destructuring from scalar record parameters and object literals',
    source: `function run(input: { value: bigint }) {
      const { value } = input;
      const { copy } = { copy: value };
      assert: copy === input.value;
    }`,
  },
  {
    name: 'a wrong record postcondition still fails',
    source: `function wrong(x: bigint) with { ensures: result.x === x; }: {x: bigint} {return {x:x+1n};}`,
    rejects: /wrong postcondition could not be proved/,
  },
  {
    name: 'an unsatisfied precondition inside a destructured call',
    source: `${pair} function run() {const { quotient } = divide(-1n, 2n); assert: quotient >= 0n;}`,
    rejects: /divide call precondition could not be proved/,
  },
  {
    name: 'unsupported destructuring defaults',
    source: `${pair} function run() {const { quotient = 0n } = divide(1n, 2n); assert: quotient === 0n;}`,
    rejects: /Unknown proof variable 'quotient'/,
  },
  {
    name: 'plain number field does not silently acquire an integer model',
    source: `function raw(): {x:number} { return {x:1.5}; }
function run() with { numberModel: 'safe-integer'; }: void {
  const {x} = raw(); assert: x % 1 === 0;
}`,
    rejects: /Unknown proof variable 'x'/,
  },
  {
    name: 'record argument numeric fields must satisfy the callee model',
    source: `function raw(r:{x:number}) with {numberModel:'safe-integer';ensures:true;}: {x:number} {return r;}
      function run() with {numberModel:'safe-integer';ensures:result;}:boolean {
        const {x}=raw({x:1.5});return x%1===0;
      }`,
    rejects: /not a safe integer/,
  },
  {
    name: 'numeric record arguments are checked even for scalar return summaries',
    source: `function raw(r:{x:number}) with {numberModel:'safe-integer';ensures:result===r.x;}:number {return r.x;}
      function run() with {numberModel:'safe-integer';ensures:result;}:boolean {return raw({x:1.5})%1===0;}`,
    rejects: /not a safe integer/,
  },
  {
    name: 'record scalar arguments bind actual values to preconditions and summaries',
    source: `function copy(r:{x:bigint}) with {requires:r.x>0n;ensures:result.x===r.x;}: {x:bigint} {return r;}
      function run() {const {x}=copy({x:2n});assert:x===2n;}`,
  },
  {
    name: 'record scalar argument preconditions still reject invalid values',
    source: `function copy(r:{x:bigint}) with {requires:r.x>0n;ensures:result.x===r.x;}: {x:bigint} {return r;}
      function run() {const {x}=copy({x:-1n});assert:x===-1n;}`,
    rejects: /copy call precondition could not be proved/,
  },
  {
    name: 'mutating record parameters cannot turn final fields into entry-state summaries',
    source: `function change(p:{x:bigint}) with {ensures:result===p.x;}:bigint {p.x=1n;return p.x;}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {return change(p);}`,
    rejects: /record parameter is (written|aliased)/,
  },
  {
    name: 'contract-free record mutators cannot preserve stale caller fields',
    source: `function change(p:{x:bigint}):void {p.x=1n;}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {change(p);return p.x;}`,
    rejects: /record parameter is (written|aliased)/,
  },
  {
    name: 'ignored initializers cannot swallow a contract-free record mutator rejection',
    source: `function change(p:{x:bigint}):void {p.x=1n;}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {
        const ignored=change(p);return p.x;
      }`,
    rejects: /record parameter is (written|aliased)/,
  },
  {
    name: 'ignored initializers propagate the unsafe-call rejection even when the caller passes a scalar copy',
    source: `function change(p:{x:bigint}):void {p.x=1n;}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {
        const ignored=change({x:p.x});return p.x;
      }`,
    rejects: /record parameter is written/,
  },
  {
    name: 'ignored method initializers propagate the unsafe-call rejection',
    source: `class Example {change(p:{x:bigint}):void {p.x=1n;}}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {
        const instance=new Example(); const ignored=instance.change({x:p.x});return p.x;
      }`,
    rejects: /record parameter is written/,
  },
  {
    name: 'record aliases cannot hide callee mutations',
    source: `function change(p:{x:bigint}) with {ensures:result===p.x;}:bigint {const alias=p;alias.x=1n;return p.x;}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {return change(p);}`,
    rejects: /record parameter is aliased/,
  },
  {
    name: 'a standalone aliased record cannot prove a stale field postcondition',
    source: `function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {
      const alias=p;alias.x=1n;return p.x;
    }`,
    rejects: /record parameter is aliased/,
  },
  {
    name: 'a standalone method cannot prove a stale field after creating a record alias',
    source: `class Example { run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {
      const alias=p;alias.x=1n;return p.x;
    } }`,
    rejects: /record parameter is aliased/,
  },
  {
    name: 'direct record writes remain verifiable within the function body',
    source: `function run(p:{x:bigint}) with {ensures:result===p.x;}:bigint {p.x=1n;return p.x;}`,
  },
  {
    name: 'direct scalar parameter writes remain verifiable within the function body',
    source: `function run(x:bigint) with {ensures:result===x;}:bigint {x=1n;return x;}`,
  },
  {
    name: 'contracted scalar parameter reassignment cannot reuse an entry argument as the final value',
    source: `function change(x:bigint) with {ensures:result===x;}:bigint {x=1n;return x;}
      function run() with {ensures:result===0n;}:bigint {return change(0n);}`,
    rejects: /contracted scalar parameter is reassigned/,
  },
  {
    name: 'a contract-free record method can mutate its receiver',
    source: `function change(p:{x:bigint;mutate:()=>void}):void {p.mutate();}
      function run(p:{x:bigint;mutate:()=>void}) with {requires:p.x===0n;ensures:result===0n;}:bigint {change(p);return p.x;}`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: 'destructuring assignment cannot hide a contract-free record write',
    source: `function change(p:{x:bigint}):void {({x:p.x}={x:1n});}
      function run(p:{x:bigint}) with {requires:p.x===0n;ensures:result===0n;}:bigint {change(p);return p.x;}`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: 'optional return fields never become unconditional scalar summaries',
    source: `function raw(): {x?:bigint} {return {};}
      function run() with {ensures:result;}:boolean {const {x}=raw();return typeof x==='bigint';}`,
    rejects: /Unknown proof variable 'x'/,
  },
  {
    name: 'union return fields absent from one variant never become unconditional scalar summaries',
    source: `type R={tag:'one';x:bigint}|{tag:'two'}; function raw():R{return {tag:'two'};}
      function run() with {ensures:result;}:boolean {const {x}=raw();return typeof x==='bigint';}`,
    rejects: /Unknown proof variable 'x'/,
  },
  {
    name: 'a fallthrough path cannot manufacture a record postcondition',
    source: `function raw(flag:boolean) with {ensures: result.x===1n;}: {x:bigint} {
      if(flag) return {x:1n};
    } function run() with {ensures: result===1n;}:bigint {const {x}=raw(false); return x;}`,
    rejects: /raw normal return definedness could not be proved/,
  },
  {
    name: 'an exhaustive discriminated union switch has no normal fallthrough',
    source: `type R={tag:'one';x:bigint}|{tag:'two'};
      function run(value:R) with {ensures:result>=0n;}:bigint {
        switch(value.tag) {case 'one': return 1n;case 'two':return 2n;}
      }`,
  },
  {
    name: 'a non-exhaustive discriminated union switch still has a normal fallthrough',
    source: `type R={tag:'one';x:bigint}|{tag:'two'};
      function run(value:R) with {ensures:result>=0n;}:bigint {
        switch(value.tag) {case 'one': return 1n;}
      }`,
    rejects: /normal return definedness could not be proved/,
  },
  {
    name: 'a declaration without a verified body cannot supply a record contract',
    source: `declare function raw() with {ensures: result.x===1n;}: {x:bigint};
      function run() with {ensures: result===1n;}:bigint {const {x}=raw(); return x;}`,
    rejects: /has no body to verify its contract/,
  },
  {
    name: 'a conditional contract is parsed with right associativity',
    source: `function choose(x:bigint) with {ensures: result === (x < 0n ? -1n : x > 0n ? 1n : 0n);}:bigint {
      return x < 0n ? -1n : x > 0n ? 1n : 0n;
    }`,
  },
  {
    name: 'conditional postcondition false branch still fails',
    source: `function choose(x:bigint) with {ensures: result === (x < 0n ? -1n : 1n);}:bigint {return 1n;}`,
    rejects: /choose postcondition could not be proved/,
  },
  {
    name: 'typeof is derived from scalar proof sort',
    source: `function types(x:bigint,s:string,b:boolean) {
      assert: typeof x === 'bigint' && typeof s === 'string' && typeof b === 'boolean';
    }`,
  },
  {
    name: 'transparent constructor follows actual assignments rather than names',
    source: `class Pair { x:bigint; y:bigint;
      constructor(x:bigint,y:bigint) {this.x=y;this.y=x;} }
function swap(x:bigint,y:bigint) with {ensures: result.x === y && result.y === x;}:Pair {return new Pair(x,y);}`,
  },
  {
    name: 'parameter properties are assigned before explicit constructor writes',
    source: `class Pair {constructor(public x:bigint,y:bigint) {this.x=y;} }
function swap(x:bigint,y:bigint) with {ensures: result.x === y;}:Pair {return new Pair(x,y);}`,
  },
  {
    name: 'false constructed field postcondition still fails',
    source: `class Pair { x:bigint; constructor(x:bigint) {this.x=x;} }
function wrong(x:bigint) with {ensures: result.x === x+1n;}:Pair {return new Pair(x);}`,
    rejects: /wrong postcondition could not be proved/,
  },
  {
    name: 'arbitrary constructor body is not projected as a transparent value',
    source: `class Pair { x:bigint; constructor(x:bigint) {this.x=x+1n;} }
function wrong(x:bigint) with {ensures: result.x === x;}:Pair {return new Pair(x);}`,
    rejects: /An object is not a value proofs can read/,
  },
  {
    name: 'fresh array methods cannot be replaced',
    source: `function run(x:bigint) { const items:bigint[]=[]; items.push = replacement;
      items.push(x); assert: x === x; }`,
    rejects: /cannot be reassigned/,
  },
  {
    name: 'fresh array aliases cannot escape via ignored initializer',
    source: `function replace(value:bigint[]):void {} function run(x:bigint) {
      const items:bigint[]=[]; const ignored = replace(items); items.push(x); assert: x === x;
    }`,
    rejects: /cannot escape/,
  },
  {
    name: 'fresh array aliases cannot escape via modeled function arguments',
    source: `function replace(value:bigint[]):void {} function run(x:bigint) {
      const items:bigint[]=[]; replace(items); items.push(x); assert: x === x;
    }`,
    rejects: /cannot escape/,
  },
  {
    name: 'array marker is removed at block scope exit',
    source: `function run(x:bigint) { {const items:bigint[]=[]; items.push(x);} const items=1n; assert: items===1n; }`,
  },
  {
    name: 'IIFE parameters cannot reuse an outer fresh array marker for a custom push callback',
    source: `function run() with {ensures: result === 0n;}:bigint {
      let n=0n; const arr:bigint[]=[];
      const dummy=((arr:{push:(v:bigint)=>number})=>{arr.push(1n);return 0n;})({push:(_v:bigint)=>{n=1n;return 1;}});
      return n;
    }`,
    rejects: /cannot shadow a tracked local array/,
  },
];
for (const item of cases) test(`${item.rejects ? 'rejects' : 'verifies'} ${item.name}`, () => expectVerification(item));
