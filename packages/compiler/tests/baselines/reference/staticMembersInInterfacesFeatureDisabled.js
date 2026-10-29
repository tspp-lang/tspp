//// [tests/cases/compiler/staticMembersInInterfacesFeatureDisabled.ts] ////

//// [staticMembersInInterfacesFeatureDisabled.ts]
interface DisabledStaticContract {
    static create(): DisabledStaticContract;
    value: string;
}

class DisabledStaticImplementation implements DisabledStaticContract {
    static create(): DisabledStaticImplementation {
        return new DisabledStaticImplementation();
    }

    value = "disabled";
}


//// [staticMembersInInterfacesFeatureDisabled.js]
"use strict";
class DisabledStaticImplementation {
    static create() {
        return new DisabledStaticImplementation();
    }
    value = "disabled";
}
