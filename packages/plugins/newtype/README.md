# `@tspp/plugin-newtype`

An isolated declaration-syntax capsule for nominal `newtype` aliases. A
newtype is assignable to its underlying type, while the underlying type and
other newtypes are not assignable back to it. Its value constructor emits as
an identity function.

The first slice supports ordinary and generic aliases without export or
declaration-file preservation guarantees.
