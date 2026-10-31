# `@tspp/plugin-newtype`

An isolated declaration-syntax capsule for nominal `newtype` aliases. A
newtype is assignable to its underlying type, while the underlying type and
other newtypes are not assignable back to it. Constructor calls are erased to
their argument, so the abstraction has no runtime allocation or call cost.

Ordinary, generic, and exported aliases are supported. Declaration emit keeps
the `newtype` syntax in `.d.ts` output so downstream TS++ projects retain the
same nominal identity and zero-cost constructor semantics.
