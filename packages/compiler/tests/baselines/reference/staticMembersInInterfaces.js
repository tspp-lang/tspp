//// [tests/cases/compiler/staticMembersInInterfaces.ts] ////

//// [staticMembersInInterfaces.ts]
interface Serializable {
    static readonly mediaType: string;
    static deserialize(text: string): this;
    serialize(): string;
}

class Good implements Serializable {
    static readonly mediaType = "application/good";

    static deserialize(_text: string): Good {
        return new Good();
    }

    serialize(): string {
        return "good";
    }
}

class MissingStatic implements Serializable {
    serialize(): string {
        return "missing";
    }
}

class WrongStatic implements Serializable {
    static readonly mediaType = 1;

    static deserialize(_text: number): WrongStatic {
        return new WrongStatic();
    }

    serialize(): string {
        return "wrong";
    }
}

class WrongStaticMethod implements Serializable {
    static readonly mediaType = "application/wrong-method";

    static deserialize(_text: number): WrongStaticMethod {
        return new WrongStaticMethod();
    }

    serialize(): string {
        return "wrong method";
    }
}

class MissingInstance implements Serializable {
    static readonly mediaType = "application/missing-instance";

    static deserialize(_text: string): MissingInstance {
        return new MissingInstance();
    }
}

interface VersionedSerializable extends Serializable {
    static fromVersion(version: number): this;
}

class GoodVersioned implements VersionedSerializable {
    static readonly mediaType = "application/versioned";

    static deserialize(_text: string): GoodVersioned {
        return new GoodVersioned();
    }

    static fromVersion(_version: number): GoodVersioned {
        return new GoodVersioned();
    }

    serialize(): string {
        return "versioned";
    }
}

class MissingInheritedStatic implements VersionedSerializable {
    static fromVersion(_version: number): MissingInheritedStatic {
        return new MissingInheritedStatic();
    }

    serialize(): string {
        return "missing inherited";
    }
}

interface MergedStaticContract {
    static first(): void;
}

interface MergedStaticContract {
    static second(): void;
}

class GoodMerged implements MergedStaticContract {
    static first(): void {}
    static second(): void {}
}

declare const serializable: Serializable;
serializable.deserialize("nope");

interface GenericStaticMethod {
    static identity<T>(value: T): T;
}

class GoodGenericStaticMethod implements GenericStaticMethod {
    static identity<T>(value: T): T {
        return value;
    }
}

interface InvalidGenericStatic<T> {
    static create(value: T): InvalidGenericStatic<T>;
}

type InvalidTypeLiteral = {
    static create(): void;
};


//// [staticMembersInInterfaces.js]
"use strict";
class Good {
    static mediaType = "application/good";
    static deserialize(_text) {
        return new Good();
    }
    serialize() {
        return "good";
    }
}
class MissingStatic {
    serialize() {
        return "missing";
    }
}
class WrongStatic {
    static mediaType = 1;
    static deserialize(_text) {
        return new WrongStatic();
    }
    serialize() {
        return "wrong";
    }
}
class WrongStaticMethod {
    static mediaType = "application/wrong-method";
    static deserialize(_text) {
        return new WrongStaticMethod();
    }
    serialize() {
        return "wrong method";
    }
}
class MissingInstance {
    static mediaType = "application/missing-instance";
    static deserialize(_text) {
        return new MissingInstance();
    }
}
class GoodVersioned {
    static mediaType = "application/versioned";
    static deserialize(_text) {
        return new GoodVersioned();
    }
    static fromVersion(_version) {
        return new GoodVersioned();
    }
    serialize() {
        return "versioned";
    }
}
class MissingInheritedStatic {
    static fromVersion(_version) {
        return new MissingInheritedStatic();
    }
    serialize() {
        return "missing inherited";
    }
}
class GoodMerged {
    static first() { }
    static second() { }
}
serializable.deserialize("nope");
class GoodGenericStaticMethod {
    static identity(value) {
        return value;
    }
}


//// [staticMembersInInterfaces.d.ts]
interface Serializable {
    static readonly mediaType: string;
    static deserialize(text: string): this;
    serialize(): string;
}
declare class Good implements Serializable {
    static readonly mediaType = "application/good";
    static deserialize(_text: string): Good;
    serialize(): string;
}
declare class MissingStatic implements Serializable {
    serialize(): string;
}
declare class WrongStatic implements Serializable {
    static readonly mediaType = 1;
    static deserialize(_text: number): WrongStatic;
    serialize(): string;
}
declare class WrongStaticMethod implements Serializable {
    static readonly mediaType = "application/wrong-method";
    static deserialize(_text: number): WrongStaticMethod;
    serialize(): string;
}
declare class MissingInstance implements Serializable {
    static readonly mediaType = "application/missing-instance";
    static deserialize(_text: string): MissingInstance;
}
interface VersionedSerializable extends Serializable {
    static fromVersion(version: number): this;
}
declare class GoodVersioned implements VersionedSerializable {
    static readonly mediaType = "application/versioned";
    static deserialize(_text: string): GoodVersioned;
    static fromVersion(_version: number): GoodVersioned;
    serialize(): string;
}
declare class MissingInheritedStatic implements VersionedSerializable {
    static fromVersion(_version: number): MissingInheritedStatic;
    serialize(): string;
}
interface MergedStaticContract {
    static first(): void;
}
interface MergedStaticContract {
    static second(): void;
}
declare class GoodMerged implements MergedStaticContract {
    static first(): void;
    static second(): void;
}
declare const serializable: Serializable;
interface GenericStaticMethod {
    static identity<T>(value: T): T;
}
declare class GoodGenericStaticMethod implements GenericStaticMethod {
    static identity<T>(value: T): T;
}
interface InvalidGenericStatic<T> {
    static create(value: T): InvalidGenericStatic<T>;
}
type InvalidTypeLiteral = {
    static create(): void;
};
