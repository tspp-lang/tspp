# 08 — Static interface members

This example enables `ts-plus-plus/plugins/static-interface-members`. Interfaces may
declare constructor-side members with `static`, and a class `implements`
clause checks those members together with the ordinary instance side.

Static signatures may use `this` for the implementing class instance type.
Inherited and declaration-merged interfaces also carry their static contract.
